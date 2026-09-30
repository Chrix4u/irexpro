/** Mobile unit tests — pure presentation logic only (Directive §J). */
process.env.EXPO_PUBLIC_API_BASE_URL ??= 'https://mobile-test.invalid/api/v1';

export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
};
