# Realtime ingress security

This runbook defines the production ingress boundary for the iRexPro Socket.IO
realtime service on the verified single-VPS Nginx/Webuzo topology.

It is an infrastructure/security control only. It does not change broker,
execution, order, strategy, signal, funding, allocation, leverage, position
sizing, stop-loss/take-profit, or risk-engine behavior.

## 1. Namespace is not the transport path

The NestJS gateway is configured with the Socket.IO namespace:

```text
/realtime
```

That namespace does **not** change the default Engine.IO HTTP/WebSocket transport
path. Unless `ServerOptions.path` is explicitly changed, Socket.IO still accepts
handshake, polling, and WebSocket-upgrade traffic at:

```text
/socket.io/
```

Production Nginx must therefore proxy `/socket.io/` to the NestJS API upstream.
If the path falls through to the Next.js `location /` block, external realtime
connections cannot reliably reach the gateway even though the namespace itself
is correct.

## 2. Canonical copyable Nginx policy

The source of truth is:

`infrastructure/nginx/irexpro-staging.example.conf`

The realtime portion must retain this shape:

```nginx
# http-context safety zones — keyed to the server, not an unverified visitor IP
limit_req_zone $server_name zone=irexpro_realtime_requests:1m rate=200r/s;
limit_conn_zone $server_name zone=irexpro_realtime_connections:1m;

location ^~ /socket.io/ {
    client_max_body_size 64k;

    limit_req zone=irexpro_realtime_requests burst=400 nodelay;
    limit_conn irexpro_realtime_connections 1000;
    limit_req_status 429;
    limit_conn_status 429;

    proxy_pass http://irexpro_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
}
```

The 64 KiB Nginx body ceiling mirrors the application-owned Socket.IO packet
ceiling. Nginx rejects oversized transport bodies before they consume Node
parsing/application capacity.

The request and connection limits are deliberately **server-wide safety
ceilings** for the single-VPS deployment. They are not presented as user quotas
or business policy. They exist to stop the public transport path from consuming
unbounded API-process resources.

## 3. Why the copyable limit is not per client

The verified staging hostname may be proxied by Cloudflare. Without trusted
Nginx real-IP processing, `$remote_addr` is intentionally the Cloudflare edge
address. That is safer than trusting a caller-supplied header, but many visitors
can share one edge address.

Therefore the repository baseline must not activate a strict per-`$remote_addr`
realtime limit unless the operator has first verified the trusted real-IP
boundary described in `reverse-proxy-client-ip-trust.md`.

Do **not** work around this by keying an Nginx or application limiter directly
to:

- `CF-Connecting-IP`
- `X-Forwarded-For`
- `X-Real-IP`

Those headers are identity inputs only after a trusted proxy-source boundary
has normalized them.

## 4. Per-client protection after trusted real-IP verification

Per-client handshake limiting is an operator-layer control. Use one of these
models:

1. Apply the rule at a trusted edge provider using the provider's verified
   visitor identity; or
2. Configure Nginx real-IP processing only for maintained official Cloudflare
   source CIDRs, verify `$remote_addr` becomes the visitor address, and then add
   a separately reviewed per-client Nginx zone.

Do not hard-code old Cloudflare CIDRs in this repository. Source and maintain
the current official ranges operationally.

Any per-client thresholds must be chosen from load/reconnect evidence. Do not
replace the server-wide safety ceiling until the new control has been tested
for carrier NAT, school/office NAT, mobile reconnects, and Cloudflare topology.

## 5. Application-layer defenses that complement ingress

Ingress protection is only the first layer. The application also owns:

- connection-time JWT/account/session-version authentication;
- persisted ownership checks before joining a trading-session room;
- session-version/status revalidation before outbound room delivery;
- per-socket/per-handler message-rate limiting before guarded JWT/database work;
- a central Socket.IO inbound packet-size ceiling.

None of those application controls substitutes for routing `/socket.io/` to the
correct upstream. Conversely, Nginx routing does not replace application
authorization.

## 6. Deployment procedure

After updating the deployed Nginx config from the reviewed repository example:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Do not reload if `nginx -t` fails.

Confirm the NestJS process remains bound to loopback/private networking and the
AI engine remains unexposed.

## 7. Non-destructive verification

Verify the Engine.IO transport reaches NestJS rather than Next.js. A request to
the transport path without a valid Socket.IO query may return a Socket.IO error;
the important property is that the response originates from the API transport
boundary rather than the frontend application.

Then use the normal web/mobile client in a controlled environment and confirm:

- the `/realtime` namespace connects;
- WebSocket upgrade succeeds;
- reconnect uses the current access token;
- authorized user-room/session-room subscriptions still work;
- unauthorized/foreign session joins remain denied;
- oversized transport requests are rejected;
- sustained excess ingress eventually receives HTTP 429 at the safety ceiling.

Do not load-test the production hostname without an approved maintenance/test
plan. Threshold tuning belongs in staging or a dedicated load-test environment.

## 8. Client-IP verification

The REST API and Socket.IO Nginx locations must both use:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

They must not use `$proxy_add_x_forwarded_for` at the NestJS identity boundary.
Send a controlled request carrying a synthetic incoming `X-Forwarded-For` and
verify it does not replace the server-observed identity passed to NestJS.

When Cloudflare real-IP processing is enabled, repeat the verification from a
public client and confirm Nginx accepts `CF-Connecting-IP` only from configured
trusted Cloudflare source networks.

## 9. Repository drift guard

`scripts/security/check-nginx-security-headers.mjs` verifies the copyable Nginx
configuration contains:

- exactly one `/api/v1/` NestJS location with the strict forwarding identity;
- exactly one `/socket.io/` NestJS transport location;
- the server-wide request/connection safety zones and limits;
- the 64 KiB transport body ceiling;
- WebSocket Upgrade headers;
- no `$proxy_add_x_forwarded_for` in NestJS identity locations;
- no direct active `CF-Connecting-IP` trust in the copyable baseline.

Release Security runs this checker on the exact pull-request candidate so these
invariants cannot silently drift.
