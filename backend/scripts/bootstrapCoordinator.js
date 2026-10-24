const path = require("node:path");
const readline = require("node:readline/promises");

const backendDirectory = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(backendDirectory, ".env") });

const bcrypt = require("bcrypt");
const pool = require("../src/config/db");

const BCRYPT_COST = 12;
const ADVISORY_LOCK_CLASS = 1414677313;
const ADVISORY_LOCK_OBJECT = 1;

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

const validateCredentials = (credentials) => {
  if (!credentials || typeof credentials !== "object") {
    throw new BootstrapError("INVALID_CREDENTIALS", "Coordinator details are required.");
  }

  const name = typeof credentials.name === "string" ? credentials.name.trim() : "";
  const email = typeof credentials.email === "string"
    ? credentials.email.trim().toLowerCase()
    : "";
  const password = typeof credentials.password === "string"
    ? credentials.password
    : "";

  if (!name || name.length > 100) {
    throw new BootstrapError(
      "INVALID_NAME",
      "Coordinator name must be between 1 and 100 characters."
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new BootstrapError("INVALID_EMAIL", "A valid coordinator email is required.");
  }
  if (password.length < 8) {
    throw new BootstrapError(
      "INVALID_PASSWORD",
      "Coordinator password must be at least 8 characters long."
    );
  }

  return { name, email, password };
};

const readHiddenPassword = async (input = process.stdin, output = process.stderr) => {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new BootstrapError(
      "PASSWORD_REQUIRED",
      "Set BOOTSTRAP_COORDINATOR_PASSWORD or run this script in an interactive terminal."
    );
  }

  output.write("Coordinator password (input hidden): ");
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let password = "";
    let settled = false;

    const restoreTerminal = () => {
      input.removeListener("data", onData);
      if (input.isTTY && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      output.write("\n");
    };

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      restoreTerminal();
      if (error) {
        reject(error);
      } else {
        resolve(password);
      }
    };

    const onData = (chunk) => {
      const value = String(chunk);
      for (const character of value) {
        if (character === "\u0003") {
          finish(new BootstrapError("CANCELLED", "Coordinator bootstrap was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
        } else if (character >= " ") {
          password += character;
        }
      }
    };

    input.on("data", onData);
  });
};

const readCredentials = async ({
  environment = process.env,
  input = process.stdin,
  output = process.stderr,
} = {}) => {
  const prompts = readline.createInterface({ input, output });
  let name = environment.BOOTSTRAP_COORDINATOR_NAME;
  let email = environment.BOOTSTRAP_COORDINATOR_EMAIL;
  let password = environment.BOOTSTRAP_COORDINATOR_PASSWORD;

  try {
    if (!name) {
      name = await prompts.question("Coordinator name: ");
    }
    if (!email) {
      email = await prompts.question("Coordinator email: ");
    }
  } finally {
    prompts.close();
  }

  if (typeof password !== "string" || password.length === 0) {
    password = await readHiddenPassword(input, output);
  }

  return validateCredentials({ name, email, password });
};

const runBootstrap = async (
  credentials,
  { databasePool, bcryptModule = bcrypt } = {}
) => {
  if (!databasePool || typeof databasePool.connect !== "function") {
    throw new TypeError("A PostgreSQL pool is required.");
  }
  const cleanCredentials = validateCredentials(credentials);
  const { name, email, password } = cleanCredentials;

  let client;
  let transactionStarted = false;
  try {
    client = await databasePool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_OBJECT]
    );

    const coordinatorResult = await client.query(
      "SELECT id FROM users WHERE role = $1 LIMIT 1",
      ["coordinator"]
    );
    if (coordinatorResult.rows.length > 0) {
      throw new BootstrapError(
        "COORDINATOR_EXISTS",
        "A coordinator account already exists; no changes were made."
      );
    }

    const emailResult = await client.query(
      "SELECT id FROM users WHERE lower(email) = $1 LIMIT 1",
      [email]
    );
    if (emailResult.rows.length > 0) {
      throw new BootstrapError(
        "EMAIL_EXISTS",
        "An account with that email already exists; no changes were made."
      );
    }

    const passwordHash = await bcryptModule.hash(password, BCRYPT_COST);
    let insertResult;
    try {
      insertResult = await client.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [name, email, passwordHash, "coordinator"]
      );
    } catch (error) {
      if (error.code === "23505") {
        throw new BootstrapError(
          "EMAIL_EXISTS",
          "An account with that email already exists; no changes were made."
        );
      }
      throw error;
    }
    if (insertResult.rows.length === 0) {
      throw new BootstrapError(
        "EMAIL_EXISTS",
        "An account with that email already exists; no changes were made."
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;
    return { created: true };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new BootstrapError(
          "DATABASE_ERROR",
          "Coordinator bootstrap failed and the database transaction could not be rolled back."
        );
      }
    }
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

const main = async ({
  databasePool = pool,
  bcryptModule = bcrypt,
  getCredentials = readCredentials,
  output = console.log,
  errorOutput = console.error,
} = {}) => {
  let exitCode = 0;
  try {
    const credentials = await getCredentials();
    await runBootstrap(credentials, { databasePool, bcryptModule });
    output("Coordinator account created successfully.");
  } catch (error) {
    exitCode = 1;
    if (error instanceof BootstrapError) {
      errorOutput(error.message);
    } else {
      errorOutput("Coordinator bootstrap failed due to a database or hashing error.");
    }
  } finally {
    try {
      await databasePool.end();
    } catch {
      errorOutput("Could not close the database connection pool cleanly.");
      exitCode = 1;
    }
  }
  return exitCode;
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    console.error("Coordinator bootstrap failed.");
    process.exitCode = 1;
  });
}

module.exports = {
  BCRYPT_COST,
  BootstrapError,
  main,
  readCredentials,
  runBootstrap,
  validateCredentials,
};
