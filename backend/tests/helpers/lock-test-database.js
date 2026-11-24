function assertDedicatedLockTestDatabase(databaseName, developmentDatabaseName) {
  if (databaseName
    && (databaseName === developmentDatabaseName || !/(^|[-_])test($|[-_])/i.test(databaseName))) {
    throw new Error('MONGODB_TEST_DATABASE must be a dedicated database name containing "test".');
  }
}

module.exports = { assertDedicatedLockTestDatabase };
