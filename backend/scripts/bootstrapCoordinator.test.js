const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  BCRYPT_COST,
  BootstrapError,
  main,
  runBootstrap,
  validateCredentials,
} = require("./bootstrapCoordinator");

const credentials = {
  name: "First Coordinator",
  email: "COORDINATOR@example.com",
  password: "safe-test-password",
};

const createFakePool = ({ existingCoordinator = false, duplicateEmail = false } = {}) => {
  const calls = [];
  let ended = false;
  let released = false;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      if (sql.includes("SELECT id FROM users WHERE role")) {
        return { rows: existingCoordinator ? [{ id: 1 }] : [] };
      }
      if (sql.includes("SELECT id FROM users WHERE lower(email)")) {
        return { rows: duplicateEmail ? [{ id: 3 }] : [] };
      }
      if (sql.includes("INSERT INTO users")) {
        return { rows: duplicateEmail ? [] : [{ id: 2 }] };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    get ended() {
      return ended;
    },
    get released() {
      return released;
    },
    async connect() {
      return client;
    },
    async end() {
      ended = true;
    },
  };
};

const fakeBcrypt = {
  async hash(password, cost) {
    assert.equal(password, credentials.password);
    assert.equal(cost, BCRYPT_COST);
    return "test-bcrypt-hash";
  },
};

test("validates and normalizes coordinator credentials", () => {
  assert.deepEqual(validateCredentials(credentials), {
    name: "First Coordinator",
    email: "coordinator@example.com",
    password: credentials.password,
  });
  assert.throws(
    () => validateCredentials({ ...credentials, password: "short" }),
    (error) => error instanceof BootstrapError && error.code === "INVALID_PASSWORD"
  );
});

test("creates a coordinator with bcrypt cost 12 and parameterized SQL", async () => {
  const databasePool = createFakePool();
  const result = await runBootstrap(credentials, {
    databasePool,
    bcryptModule: fakeBcrypt,
  });
  const insert = databasePool.calls.find((call) => call.sql.includes("INSERT INTO users"));

  assert.deepEqual(result, { created: true });
  assert.deepEqual(insert.values, [
    "First Coordinator",
    "coordinator@example.com",
    "test-bcrypt-hash",
    "coordinator",
  ]);
  assert.match(insert.sql, /ON CONFLICT \(email\) DO NOTHING/);
  assert.equal(databasePool.released, true);
});

test("refuses to create another coordinator and rolls back", async () => {
  const databasePool = createFakePool({ existingCoordinator: true });

  await assert.rejects(
    runBootstrap(credentials, { databasePool, bcryptModule: fakeBcrypt }),
    (error) => error instanceof BootstrapError && error.code === "COORDINATOR_EXISTS"
  );
  assert.equal(
    databasePool.calls.some((call) => call.sql.includes("INSERT INTO users")),
    false
  );
  assert.equal(
    databasePool.calls.some((call) => call.sql === "ROLLBACK"),
    true
  );
  assert.equal(databasePool.released, true);
});

test("duplicate email does not overwrite an existing account", async () => {
  const databasePool = createFakePool({ duplicateEmail: true });

  await assert.rejects(
    runBootstrap(credentials, { databasePool, bcryptModule: fakeBcrypt }),
    (error) => error instanceof BootstrapError && error.code === "EMAIL_EXISTS"
  );
  assert.equal(
    databasePool.calls.some((call) => call.sql.includes("UPDATE users")),
    false
  );
  assert.equal(
    databasePool.calls.some((call) =>
      call.sql.includes("SELECT id FROM users WHERE lower(email) = $1")
    ),
    true
  );
  assert.equal(
    databasePool.calls.some((call) => call.sql.includes("INSERT INTO users")),
    false
  );
  assert.equal(
    databasePool.calls.some((call) => call.sql === "ROLLBACK"),
    true
  );
});

test("main closes the pool on success and returns a success status", async () => {
  const databasePool = createFakePool();
  const output = [];
  const errorOutput = [];
  const exitCode = await main({
    databasePool,
    bcryptModule: fakeBcrypt,
    getCredentials: async () => credentials,
    output: (message) => output.push(message),
    errorOutput: (message) => errorOutput.push(message),
  });

  assert.equal(exitCode, 0);
  assert.equal(databasePool.ended, true);
  assert.deepEqual(output, ["Coordinator account created successfully."]);
  assert.deepEqual(errorOutput, []);
});

test("main safely reports an existing coordinator and still closes the pool", async () => {
  const databasePool = createFakePool({ existingCoordinator: true });
  const output = [];
  const errorOutput = [];
  const exitCode = await main({
    databasePool,
    bcryptModule: fakeBcrypt,
    getCredentials: async () => credentials,
    output: (message) => output.push(message),
    errorOutput: (message) => errorOutput.push(message),
  });

  assert.equal(exitCode, 1);
  assert.equal(databasePool.ended, true);
  assert.deepEqual(output, []);
  assert.deepEqual(errorOutput, [
    "A coordinator account already exists; no changes were made.",
  ]);
});
