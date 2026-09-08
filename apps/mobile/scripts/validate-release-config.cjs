const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const requireProjectId = process.argv.includes('--require-project-id');
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
expect(build.development?.distribution === 'internal', 'development profile must use internal distribution');
expect(build.preview?.distribution === 'internal', 'preview profile must use internal distribution');
expect(build.production?.distribution === 'store', 'production profile must use store distribution');
expect(build.production?.autoIncrement === true, 'production profile must auto-increment remote platform build versions');
expect(build.production?.android?.buildType === 'app-bundle', 'production Android build must produce an app bundle');

validatePublicEnv(build);

const developmentEnv = resolveProfileEnv(build, 'development');
const previewEnv = resolveProfileEnv(build, 'preview');
const productionEnv = resolveProfileEnv(build, 'production');
const expectedProductionApi = 'https://irexpro.lightworldtech.com/api/v1';

expect(developmentEnv.EXPO_PUBLIC_APP_ENV === 'development', 'development profile must set EXPO_PUBLIC_APP_ENV=development');
expect(previewEnv.EXPO_PUBLIC_APP_ENV === 'staging', 'preview profile must set EXPO_PUBLIC_APP_ENV=staging');
expect(productionEnv.EXPO_PUBLIC_APP_ENV === 'production', 'production profile must set EXPO_PUBLIC_APP_ENV=production');
expect(productionEnv.EXPO_PUBLIC_API_BASE_URL === expectedProductionApi, `production API base URL must be ${expectedProductionApi}`);

try {
  const productionApi = new URL(productionEnv.EXPO_PUBLIC_API_BASE_URL || '');
  expect(productionApi.protocol === 'https:', 'production API base URL must use HTTPS');
  expect(!['localhost', '127.0.0.1', '::1'].includes(productionApi.hostname), 'production API base URL must not point to localhost');
} catch {
  fail('production API base URL must be a valid absolute URL');
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

console.log(`Mobile release configuration valid (${requireProjectId ? 'linked release preflight' : 'source validation'}).`);
