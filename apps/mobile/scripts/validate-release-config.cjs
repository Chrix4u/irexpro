const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const requireProjectId = process.argv.includes('--require-project-id');
const requireProductionApi = process.argv.includes('--require-production-api');
const easBuildMode = process.argv.includes('--eas-build');
const errors = [];

function readJson(fileName) {
  const filePath = path.join(mobileRoot, fileName);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function fail(message) {
  errors.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isPositiveIntegerString(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function resolveProfileEnv(build, profileName) {
  const profile = build[profileName] || {};
  const parent = profile.extends ? build[profile.extends] || {} : {};
  return { ...(parent.env || {}), ...(profile.env || {}) };
}

function validatePublicEnv(build) {
  for (const [profileName, profile] of Object.entries(build)) {
    if (!profile || typeof profile !== 'object') continue;
    const env = profile.env || {};
    for (const key of Object.keys(env)) {
      expect(
        key.startsWith('EXPO_PUBLIC_'),
        `eas.json build.${profileName}.env.${key} is not explicitly public; do not commit secrets or backend-only environment values to EAS profile env`,
      );
    }
  }
}

function pluginName(plugin) {
  if (typeof plugin === 'string') return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === 'string') return plugin[0];
  return null;
}

function pluginOptions(plugin) {
  if (Array.isArray(plugin) && plugin[1] && typeof plugin[1] === 'object') return plugin[1];
  return {};
}

function enablesHermesV1(options) {
  return options.useHermesV1 === true ||
    options.android?.useHermesV1 === true ||
    options.ios?.useHermesV1 === true;
}

function parseHttpsApi(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty absolute HTTPS URL`);
    return null;
  }

  try {
    const url = new URL(value);
    expect(url.protocol === 'https:', `${label} must use HTTPS`);
    expect(
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname),
      `${label} must not point to localhost`,
    );
    return url;
  } catch {
    fail(`${label} must be a valid absolute URL`);
    return null;
  }
}

function normalizedApiUrl(url) {
  return url ? url.toString().replace(/\/$/, '') : null;
}

const appJson = readJson('app.json');
const easJson = readJson('eas.json');
const packageJson = readJson('package.json');
const expo = appJson.expo || {};
const build = easJson.build || {};
const dependencies = packageJson.dependencies || {};
const plugins = Array.isArray(expo.plugins) ? expo.plugins : [];
const pluginNames = plugins.map(pluginName).filter(Boolean);

expect(expo.name === 'iRexPro', 'app.json expo.name must remain iRexPro');
expect(expo.slug === 'irexpro-mobile', 'app.json expo.slug must remain irexpro-mobile');
expect(typeof expo.version === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(expo.version), 'app.json expo.version must be a semantic version');
expect(expo.ios?.bundleIdentifier === 'com.irexpro.mobile', 'iOS bundleIdentifier must remain com.irexpro.mobile');
expect(expo.android?.package === 'com.irexpro.mobile', 'Android package must remain com.irexpro.mobile');
expect(isPositiveIntegerString(expo.ios?.buildNumber), 'iOS buildNumber must be a positive integer string used to seed remote EAS versioning');
expect(isPositiveInteger(expo.android?.versionCode), 'Android versionCode must be a positive integer used to seed remote EAS versioning');

expect(
  !Object.prototype.hasOwnProperty.call(expo, 'newArchEnabled'),
  'Expo SDK 55 removed the newArchEnabled app-config option; New Architecture is mandatory and this field must remain absent',
);
expect(expo.userInterfaceStyle === 'dark', 'app.json expo.userInterfaceStyle must remain dark');
expect(pluginNames.includes('expo-secure-store'), 'app.json must retain the expo-secure-store config plugin');
expect(pluginNames.includes('expo-system-ui'), 'app.json must include expo-system-ui so the global interface style is applied on Android');

expect(/^~55\./.test(dependencies.expo || ''), 'mobile Expo dependency must remain on the SDK 55 release line');
expect(/^0\.83\./.test(dependencies['react-native'] || ''), 'mobile React Native dependency must remain on the SDK 55 RN 0.83 line');
expect(/^19\.2\./.test(dependencies.react || ''), 'mobile React dependency must remain on the SDK 55 React 19.2 line');
expect(/^~55\./.test(dependencies['expo-secure-store'] || ''), 'expo-secure-store must remain Expo SDK 55 aligned');
expect(/^~55\./.test(dependencies['expo-system-ui'] || ''), 'expo-system-ui must remain Expo SDK 55 aligned');

for (const plugin of plugins) {
  if (pluginName(plugin) !== 'expo-build-properties') continue;
  expect(
    !enablesHermesV1(pluginOptions(plugin)),
    'Hermes v1 must remain disabled for the SDK 55 checkpoint; do not set useHermesV1=true in expo-build-properties',
  );
}

expect(easJson.cli?.appVersionSource === 'remote', 'eas.json cli.appVersionSource must be remote');
expect(easJson.cli?.requireCommit === true, 'eas.json cli.requireCommit must be true for reproducible release builds');

for (const profileName of ['base', 'development', 'preview', 'production']) {
  expect(build[profileName] && typeof build[profileName] === 'object', `eas.json is missing build.${profileName}`);
}

expect(build.base?.node === '22.23.2', 'EAS base profile must pin Node 22.23.2 to match validated CI tooling');
expect(build.base?.pnpm === '10.34.5', 'EAS base profile must pin pnpm 10.34.5 to match the workspace packageManager');
expect(build.base?.credentialsSource === 'remote', 'EAS base profile must use remotely managed signing credentials');
expect(build.development?.extends === 'base', 'development profile must extend base');
expect(build.preview?.extends === 'base', 'preview profile must extend base');
expect(build.production?.extends === 'base', 'production profile must extend base');
expect(build.development?.environment === 'development', 'development profile must use the EAS development environment');
expect(build.preview?.environment === 'preview', 'preview profile must use the EAS preview environment');
expect(build.production?.environment === 'production', 'production profile must use the EAS production environment');
expect(build.development?.distribution === 'internal', 'development profile must use internal distribution');
expect(build.preview?.distribution === 'internal', 'preview profile must use internal distribution');
expect(build.production?.distribution === 'store', 'production profile must use store distribution');
expect(build.production?.autoIncrement === true, 'production profile must auto-increment remote platform build versions');
expect(build.production?.android?.buildType === 'app-bundle', 'production Android build must produce an app bundle');

validatePublicEnv(build);

const developmentEnv = resolveProfileEnv(build, 'development');
const previewEnv = resolveProfileEnv(build, 'preview');
const productionEnv = resolveProfileEnv(build, 'production');
const expectedStagingApi = 'https://irexpro.lightworldtech.com/api/v1';

expect(developmentEnv.EXPO_PUBLIC_APP_ENV === 'development', 'development profile must set EXPO_PUBLIC_APP_ENV=development');
expect(previewEnv.EXPO_PUBLIC_APP_ENV === 'staging', 'preview profile must set EXPO_PUBLIC_APP_ENV=staging');
expect(productionEnv.EXPO_PUBLIC_APP_ENV === 'production', 'production profile must set EXPO_PUBLIC_APP_ENV=production');
expect(previewEnv.EXPO_PUBLIC_API_BASE_URL === expectedStagingApi, `preview API base URL must remain the verified staging endpoint ${expectedStagingApi}`);
expect(
  !Object.prototype.hasOwnProperty.call(build.base?.env || {}, 'EXPO_PUBLIC_API_BASE_URL'),
  'base profile must not define EXPO_PUBLIC_API_BASE_URL because it would leak one endpoint into every environment',
);
expect(
  !Object.prototype.hasOwnProperty.call(build.production?.env || {}, 'EXPO_PUBLIC_API_BASE_URL'),
  'production profile must not commit EXPO_PUBLIC_API_BASE_URL; source it from the EAS production environment',
);

const stagingApi = parseHttpsApi(previewEnv.EXPO_PUBLIC_API_BASE_URL, 'preview/staging API base URL');

const easBuildProfile = process.env.EAS_BUILD_PROFILE?.trim() || null;
if (easBuildMode) {
  expect(
    ['development', 'preview', 'production'].includes(easBuildProfile),
    `EAS_BUILD_PROFILE must identify development, preview, or production (got ${easBuildProfile || 'missing'})`,
  );
}

const mustValidateRuntimeProductionApi =
  requireProductionApi || (easBuildMode && easBuildProfile === 'production');

if (easBuildMode && easBuildProfile === 'preview') {
  const runtimePreviewApi = parseHttpsApi(
    process.env.EXPO_PUBLIC_API_BASE_URL,
    'EAS preview runtime API base URL',
  );
  if (runtimePreviewApi && stagingApi) {
    expect(
      normalizedApiUrl(runtimePreviewApi) === normalizedApiUrl(stagingApi),
      `EAS preview runtime API must resolve to the verified staging endpoint ${expectedStagingApi}`,
    );
  }
}

if (mustValidateRuntimeProductionApi) {
  const productionApi = parseHttpsApi(
    process.env.EXPO_PUBLIC_API_BASE_URL,
    'EAS production runtime API base URL',
  );
  if (productionApi && stagingApi) {
    expect(
      normalizedApiUrl(productionApi) !== normalizedApiUrl(stagingApi),
      'production API base URL must not equal the preview/staging API base URL',
    );
    expect(
      productionApi.hostname !== stagingApi.hostname,
      `production API hostname must be distinct from the verified staging hostname ${stagingApi.hostname}`,
    );
  }
} else {
  console.log('Production API URL: intentionally externalized to the EAS production environment.');
}

const projectId = expo.extra?.eas?.projectId;
if (projectId === undefined) {
  if (requireProjectId) {
    fail('EAS project is not linked: run `eas init` from apps/mobile using the authorized Expo account, verify the generated project ID, then commit only the resulting extra.eas.projectId');
  } else {
    console.log('EAS project link: intentionally absent (repository-safe unlinked state).');
  }
} else if (!isUuid(projectId)) {
  fail('app.json extra.eas.projectId exists but is not a valid non-placeholder UUID');
} else {
  console.log(`EAS project link: valid UUID present (${projectId.slice(0, 8)}… redacted).`);
}

if (errors.length > 0) {
  console.error('Mobile release configuration validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

let validationMode = 'source validation';
if (easBuildMode) validationMode = `EAS ${easBuildProfile || 'unknown'} build validation`;
else if (requireProjectId || requireProductionApi) validationMode = 'linked release preflight';
console.log(`Mobile release configuration valid (${validationMode}).`);
