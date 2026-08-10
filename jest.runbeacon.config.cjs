module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/tests/CredentialProfileStore.test.ts',
    '<rootDir>/src/tests/GitCredentialManager.test.ts',
    '<rootDir>/src/tests/GitHubActionsMonitor.test.ts',
    '<rootDir>/src/tests/GitHubApiClient.test.ts',
    '<rootDir>/src/tests/GitHubPublish.test.ts',
    '<rootDir>/src/tests/GitHubWorkflowEligibility.test.ts',
    '<rootDir>/src/tests/LifecycleManager.test.ts',
    '<rootDir>/src/tests/PluginHooks.test.ts',
    '<rootDir>/src/tests/RunBeaconV3Security.test.ts',
    '<rootDir>/src/tests/SshPasswordProfileManager.test.ts'
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.+)\\.js$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }]
  },
  testTimeout: 45000,
  clearMocks: true,
  restoreMocks: true,
  resetMocks: true,
  reporters: ['default']
};
