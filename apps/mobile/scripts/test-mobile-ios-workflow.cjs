const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/mobile-ios-testflight.yml');
assert.ok(fs.existsSync(workflowPath), 'A dedicated iOS TestFlight workflow must exist');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const eas = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eas.json'), 'utf8'));

assert.match(workflow, /workflow_dispatch:/, 'TestFlight publication must require an intentional manual dispatch');
assert.match(workflow, /push:[\s\S]*?tags:[\s\S]*?irexpro-ios-v\\*/, 'TestFlight workflow must support exact tagged iOS release candidates');
assert.match(workflow, /EXPO_TOKEN:\s*\$\{\{\s*secrets\.EXPO_TOKEN\s*\}\}/, 'Workflow must source Expo authentication only from the repository secret');
assert.match(workflow, /test -n "\$\{EXPO_TOKEN:-\}"/, 'Workflow must fail closed before EAS work when EXPO_TOKEN is absent');
assert.match(workflow, /eas build --platform ios --profile testflight/, 'Workflow must build the dedicated TestFlight iOS profile');
assert.match(workflow, /eas submit --platform ios --profile testflight/, 'Workflow must submit the validated iOS build to TestFlight');
assert.match(workflow, /testflight-build\.json/, 'Workflow must preserve non-secret EAS build evidence');
assert.doesNotMatch(workflow, /EXPO_TOKEN:\s*['"][^$]/, 'Workflow must never embed an Expo token literal');
assert.doesNotMatch(workflow, /APPLE_(?:ID|PASSWORD|APP_SPECIFIC_PASSWORD):\s*['"][^$]/, 'Workflow must never embed Apple credentials');

assert.equal(eas.build?.testflight?.extends, 'base', 'TestFlight profile must inherit the pinned EAS base toolchain');
assert.equal(eas.build?.testflight?.environment, 'preview', 'TestFlight QA build must use the EAS preview environment');
assert.equal(eas.build?.testflight?.distribution, 'store', 'TestFlight requires a store-signed iOS build');
assert.equal(eas.build?.testflight?.autoIncrement, true, 'TestFlight build numbers must auto-increment');
assert.equal(eas.build?.testflight?.env?.EXPO_PUBLIC_APP_ENV, 'staging', 'TestFlight QA must identify itself as staging');
assert.equal(
  eas.build?.testflight?.env?.EXPO_PUBLIC_API_BASE_URL,
  'https://irexpro.lightworldtech.com/api/v1',
  'TestFlight QA must point only at the verified staging API',
);
assert.ok(eas.submit?.testflight?.ios, 'A TestFlight submit profile must exist for iOS');

console.log('mobile iOS/TestFlight workflow guard: PASS');
