/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '\\.(css)$': '<rootDir>/jest-style-mock.js',
  },
  transform: {
    '^.+\\.(t|j)sx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }],
  },
  testRegex: '.*\\.spec\\.tsx?$',
  testPathIgnorePatterns: ['<rootDir>/e2e/', '/node_modules/'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'],
};
