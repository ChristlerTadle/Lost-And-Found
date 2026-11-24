function stateConflict(message) {
  const error = new Error(message);
  error.status = 409;
  error.code = 'state_conflict';
  return error;
}

module.exports = { stateConflict };
