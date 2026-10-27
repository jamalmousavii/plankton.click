module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  clearMocks: true,
  verbose: true,
  moduleNameMapper: {
    // The Phase-4 suites load worker-app sources; resolve their bare requires
    // (ws, axios) against backend's node_modules, where worker-app/node_modules
    // may not be installed.
    '^ws$': '<rootDir>/node_modules/ws',
    '^axios$': '<rootDir>/node_modules/axios',
  },
};
