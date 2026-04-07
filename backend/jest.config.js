export default {
  testEnvironment: 'node',
  transform: {},
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  moduleNameMapper: {
    // Force Jest to resolve the standard Node entrypoint instead of browser
    '^@prisma/client$': '<rootDir>/node_modules/@prisma/client/index.js'
  }
};
