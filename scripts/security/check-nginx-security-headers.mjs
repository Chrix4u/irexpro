import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const nginxPath = fileURLToPath(
  new URL('../../infrastructure/nginx/irexpro-staging.example.conf', import.meta.url),
);
const source = readFileSync(nginxPath, 'utf8');
const activeDirectives = source.replace(/#.*$/gm, '');

const HSTS = 'add_header Strict-Transport-Security "max-age=31536000" always;';
const REQUIRED_STATIC_HEADERS = [
  HSTS,
  'add_header X-Content-Type-Options "nosniff" always;',
  'add_header X-Frame-Options "SAMEORIGIN" always;',
  'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
  'add_header Cache-Control "public, immutable";',
];
const REALTIME_REQUEST_ZONE =
  'limit_req_zone $server_name zone=irexpro_realtime_requests:1m rate=200r/s;';
const REALTIME_CONNECTION_ZONE =
  'limit_conn_zone $server_name zone=irexpro_realtime_connections:1m;';
const REQUIRED_REALTIME_DIRECTIVES = [
  'client_max_body_size 64k;',
  'limit_req zone=irexpro_realtime_requests burst=400 nodelay;',
  'limit_conn irexpro_realtime_connections 1000;',
  'limit_req_status 429;',
  'limit_conn_status 429;',
  'proxy_pass http://irexpro_api;',
  'proxy_http_version 1.1;',
  'proxy_set_header X-Real-IP $remote_addr;',
  'proxy_set_header X-Forwarded-For $remote_addr;',
  'proxy_set_header X-Forwarded-Proto $scheme;',
  'proxy_set_header Upgrade $http_upgrade;',
  'proxy_set_header Connection "upgrade";',
  'proxy_buffering off;',
];

function fail(message) {
  console.error(`Nginx security policy failed: ${message}`);
  process.exitCode = 1;
}

function extractBlocks(text, opening) {
  const blocks = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(opening, cursor);
    if (start === -1) break;

    const braceStart = text.indexOf('{', start);
    if (braceStart === -1) {
      fail(`malformed block opening: ${opening}`);
      return blocks;
    }

    let depth = 0;
    let end = -1;
    for (let index = braceStart; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }

    if (end === -1) {
      fail(`unterminated block opening: ${opening}`);
      return blocks;
    }

    blocks.push(text.slice(start, end));
    cursor = end;
  }

  return blocks;
}

if (/\bincludeSubDomains\b/i.test(activeDirectives)) {
  fail('includeSubDomains must not be enabled without separate operational validation');
}
if (/\bpreload\b/i.test(activeDirectives)) {
  fail('HSTS preload must not be enabled without separate operational validation');
}
if (/\breal_ip_header\s+CF-Connecting-IP\s*;/i.test(activeDirectives)) {
  fail('copyable Nginx baseline must not trust CF-Connecting-IP without maintained source CIDRs');
}

for (const directive of [REALTIME_REQUEST_ZONE, REALTIME_CONNECTION_ZONE]) {
  const count = activeDirectives.split(directive).length - 1;
  if (count !== 1) {
    fail(`expected exactly one realtime safety-zone directive: ${directive}`);
  }
}

const allServers = extractBlocks(activeDirectives, 'server {');
if (allServers.length !== 4) {
  fail(`expected exactly 4 iRexPro server blocks, found ${allServers.length}`);
}

for (const block of allServers) {
  const tokenDirectives = [...block.matchAll(/\bserver_tokens\s+([^;]+);/g)];
  if (tokenDirectives.length !== 1) {
    fail(`expected exactly 1 server_tokens directive per server block, found ${tokenDirectives.length}`);
  } else if (tokenDirectives[0][1].trim() !== 'off') {
    fail(`server_tokens must remain off, found ${tokenDirectives[0][1].trim()}`);
  }
}

const httpsServers = allServers.filter((block) => block.includes('listen 443 ssl http2;'));

if (httpsServers.length !== 2) {
  fail(`expected exactly 2 HTTPS server blocks, found ${httpsServers.length}`);
}

for (const block of httpsServers) {
  if (!block.includes(HSTS)) {
    fail('every HTTPS server block must emit the hostname-scoped HSTS policy');
  }
}

const apiLocations = extractBlocks(activeDirectives, 'location ^~ /api/v1/ {');
if (apiLocations.length !== 1) {
  fail(`expected exactly 1 public API location, found ${apiLocations.length}`);
} else {
  const apiLocation = apiLocations[0];
  const bodyLimitDirectives = [...apiLocation.matchAll(/\bclient_max_body_size\s+([^;]+);/g)];

  if (bodyLimitDirectives.length !== 1) {
    fail(`expected exactly 1 API client_max_body_size directive, found ${bodyLimitDirectives.length}`);
  } else if (bodyLimitDirectives[0][1].trim() !== '100k') {
    fail(`public API client_max_body_size must remain 100k, found ${bodyLimitDirectives[0][1].trim()}`);
  }

  if (!apiLocation.includes('proxy_set_header X-Forwarded-For $remote_addr;')) {
    fail('public API location must replace X-Forwarded-For with server-observed $remote_addr');
  }
  if (apiLocation.includes('$proxy_add_x_forwarded_for')) {
    fail('public API location must not preserve caller-supplied X-Forwarded-For chains');
  }
}

const realtimeLocations = extractBlocks(activeDirectives, 'location ^~ /socket.io/ {');
if (realtimeLocations.length !== 1) {
  fail(`expected exactly 1 Socket.IO transport location, found ${realtimeLocations.length}`);
} else {
  const realtimeLocation = realtimeLocations[0];
  for (const directive of REQUIRED_REALTIME_DIRECTIVES) {
    if (!realtimeLocation.includes(directive)) {
      fail(`Socket.IO transport location is missing required directive: ${directive}`);
    }
  }
  if (realtimeLocation.includes('$proxy_add_x_forwarded_for')) {
    fail('Socket.IO transport must not preserve caller-supplied X-Forwarded-For chains');
  }
  if (/\bCF-Connecting-IP\b/i.test(realtimeLocation)) {
    fail('Socket.IO transport must not trust CF-Connecting-IP directly');
  }
}

const staticLocations = extractBlocks(source, 'location ^~ /_next/static/ {');
if (staticLocations.length !== 2) {
  fail(`expected exactly 2 Next.js static locations, found ${staticLocations.length}`);
}

for (const block of staticLocations) {
  for (const header of REQUIRED_STATIC_HEADERS) {
    if (!block.includes(header)) {
      fail(`static location is missing required header: ${header}`);
    }
  }
}

if (!process.exitCode) {
  console.log(
    'Nginx transport-security, API identity, realtime ingress, and server-token policy passed.',
  );
}
