const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/mobile-apk.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

assert.match(workflow, /\n  pull_request:\n/, 'APK workflow must validate native builds on pull requests before merge');
assert.match(workflow, /  pull_request:[\s\S]*?paths:[\s\S]*?apps\/mobile\/\*\*/, 'APK PR validation must be scoped to mobile changes');
assert.match(workflow, /push:[\s\S]*?branches:[\s\S]*?deploy\/daily-loss-reset-20261028/, 'APK preview workflow must build mobile changes pushed to the staging deployment branch');

assert.match(workflow, /push:[\s\S]*?tags:[\s\S]*?irexpro-mobile-v\\*/, 'APK workflow must build durable mobile release tags');
assert.match(workflow, /iRexPro-Android-Preview\.apk/, 'Tagged Android releases must use a stable APK asset name');
assert.match(workflow, /SHA256SUMS\.txt/, 'Tagged Android releases must publish a stable checksum asset');
assert.match(workflow, /release-android:[\s\S]*?if:.*refs\/tags\/irexpro-mobile-v/, 'GitHub Release publication must be tag-only');
assert.match(workflow, /release-android:[\s\S]*?permissions:[\s\S]*?contents: write/, 'Only the release job should receive contents write permission');
assert.match(workflow, /release-android:[\s\S]*?softprops\/action-gh-release/, 'Tagged Android builds must publish GitHub Release assets');
assert.doesNotMatch(workflow, /permissions:\n  contents: write/, 'The whole workflow must not grant branch preview jobs repository write permission');

const installMarker = '- name: Install pinned Android native toolchain';
const buildMarker = '- name: Build standalone release APK';
const installIndex = workflow.indexOf(installMarker);
const buildIndex = workflow.indexOf(buildMarker);

assert.ok(installIndex >= 0, 'APK workflow must preinstall the pinned Android native toolchain');
assert.ok(buildIndex >= 0, 'APK workflow must contain the standalone release build step');
assert.ok(installIndex < buildIndex, 'Pinned Android native toolchain must be installed before Gradle starts');
assert.doesNotMatch(workflow, /\\n\s*&&/, 'APK workflow shell must not contain escaped newline tokens');
assert.match(workflow, /install_cmake_version '3\.22\.1'/, 'APK workflow must preinstall Expo CMake 3.22.1');
assert.match(workflow, /install_cmake_version '3\.30\.5'/, 'APK workflow must preinstall React Native CMake 3.30.5');
assert.match(workflow, /"\$sdkmanager" --install "cmake;\$version"/, 'Pinned CMake versions must be installed through sdkmanager');
assert.match(workflow, /cmake.*--version|--version.*cmake/s, 'APK workflow must verify installed CMake binaries');

console.log('mobile-apk workflow native-toolchain guard: PASS');
