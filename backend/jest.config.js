export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    // Force Jest to resolve the standard Node entrypoint instead of browser
    '^@prisma/client$': '<rootDir>/node_modules/@prisma/client/index.js'
  }
};
