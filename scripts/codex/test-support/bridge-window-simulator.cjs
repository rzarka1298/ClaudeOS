// STUB (RED): replaced by the real simulator in the GREEN commit.
function createWindowSimulator() {
  return {
    heartbeat() {},
    tick() {
      return [];
    },
    close() {},
    log: [],
  };
}

module.exports = { createWindowSimulator };
