'use strict';

// Messages and event details are codes, never third-party errors or page content.
class RobotError extends Error {
  constructor(code) { super(code); this.name = 'RobotError'; this.code = code; }
}
const fail = code => { throw new RobotError(code); };
const safeError = error => error instanceof RobotError ? error.code : 'ROBOT_FAILED';
module.exports = { RobotError, fail, safeError };
