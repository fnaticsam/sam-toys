'use strict';
// Test entry point for the requested `node --test robot/ba` command.
// Production entry point is cli.js; importing this directory never starts a robot.
require('./test/parsers.test');
require('./test/store.test');
require('./test/providers.test');
require('./test/robot.test');
require('./test/cli.test');
