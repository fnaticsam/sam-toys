// Existing handler acceptance suites isolate their auth/body contracts from the
// durable backend. Dedicated security suites exercise real controls with CAS mocks.
const path = require('node:path');
function install(repo) {
  const controls = require(path.join(repo, 'api/_lib/abuse-controls'));
  controls.reservePaid = async () => ({ release: async () => {} });
  controls.checkLogin = async () => {};
}
module.exports = { install };
