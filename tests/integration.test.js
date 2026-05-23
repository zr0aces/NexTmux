const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const TEST_PORT = 8089;
const PASSWORD = "testpassword123";
let serverProcess;
let tokenCookie = "";

// Helper to make HTTP requests to the test server
function request(method, pathname, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const reqHeaders = { ...headers };
    if (body) {
      reqHeaders["Content-Type"] = "application/json";
    }
    if (tokenCookie) {
      reqHeaders["Cookie"] = tokenCookie;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: pathname,
        method,
        headers: reqHeaders,
      },
      res => {
        let resData = "";
        res.on("data", chunk => (resData += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(resData);
          } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, rawBody: resData });
        });
      }
    );
    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

before(() => {
  const mockBinDir = path.join(__dirname, "mock-bin");
  if (!fs.existsSync(mockBinDir)) {
    fs.mkdirSync(mockBinDir, { recursive: true });
  }
  const mockTmuxPath = path.join(mockBinDir, "tmux");
  const mockTmuxContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('ls')) {
  console.log("term-1|/mock/cwd/1|bash");
  console.log("term-2|/mock/cwd/2|zsh");
  console.log("untracked-session|/mock/cwd/untracked|python");
  process.exit(0);
}
if (args.includes('has-session')) {
  process.exit(0);
}
if (args.includes('capture-pane') || args.includes('display-message')) {
  if (args.includes('display-message')) {
    console.log("/mock/cwd/1|||bash");
  } else {
    console.log("Hello. Listening on http://localhost:4000");
  }
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(mockTmuxPath, mockTmuxContent);
  fs.chmodSync(mockTmuxPath, 0o755);

  return new Promise((resolve, reject) => {
    // Start server.js as a subprocess
    serverProcess = spawn("node", ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PORT: TEST_PORT,
        DASHBOARD_PASSWORD: PASSWORD,
        PATH: mockBinDir + path.delimiter + process.env.PATH,
        AI_MONITOR_ENABLED: "0",
        ENABLE_TUNNEL: "0",
        ENABLE_TUNNEL_HEALTHCHECK: "0"
      }
    });

    let resolved = false;
    const checkServer = () => {
      const req = http.get(`http://127.0.0.1:${TEST_PORT}/`, (res) => {
        if (res.statusCode === 200) {
          resolved = true;
          resolve();
        } else {
          setTimeout(checkServer, 100);
        }
      });
      req.on("error", () => {
        setTimeout(checkServer, 100);
      });
    };
    
    // Set a timeout to prevent hanging forever if server fails to start
    setTimeout(() => {
      if (!resolved) {
        serverProcess.kill();
        reject(new Error("Timeout waiting for test server to start"));
      }
    }, 5000);

    setTimeout(checkServer, 100);
  });
});

after(() => {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
  }
  // Remove the mock directory
  try {
    fs.rmSync(path.join(__dirname, "mock-bin"), { recursive: true, force: true });
  } catch (e) {}
});

test("Integration tests for TmuxHub API", async (t) => {
  // 1. Perform login
  const loginRes = await request("POST", "/api/login", { pw: PASSWORD });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.ok, true);
  
  const setCookie = loginRes.headers["set-cookie"];
  assert.ok(setCookie);
  tokenCookie = setCookie[0].split(";")[0];

  // 2. Scan dedup test
  await t.test("GET /api/scan should exclude already tracked sessions", async () => {
    const scanRes = await request("GET", "/api/scan");
    assert.equal(scanRes.status, 200);
    assert.ok(Array.isArray(scanRes.body));
    
    // term-1 and term-2 are already tracked via recoverSessions at startup,
    // so they should NOT be in the scan results.
    const names = scanRes.body.map(s => s.sessionName);
    assert.ok(!names.includes("term-1"));
    assert.ok(!names.includes("term-2"));
    assert.ok(names.includes("untracked-session"));
  });

  // 3. Double-attach guard test
  await t.test("POST /api/attach twice should return the same worker ID", async () => {
    const attachRes1 = await request("POST", "/api/attach", {
      sessionName: "untracked-session",
      cwd: "/mock/cwd/untracked"
    });
    assert.equal(attachRes1.status, 200);
    const workerId = attachRes1.body.id;
    assert.ok(workerId);

    // Call attach again with the same sessionName
    const attachRes2 = await request("POST", "/api/attach", {
      sessionName: "untracked-session",
      cwd: "/mock/cwd/untracked"
    });
    assert.equal(attachRes2.status, 200);
    assert.equal(attachRes2.body.id, workerId);
    
    // Check that we don't have multiple workers for it
    const workersRes = await request("GET", "/api/workers");
    assert.equal(workersRes.status, 200);
    const matchingWorkers = workersRes.body.filter(w => w.sessionName === "untracked-session");
    assert.equal(matchingWorkers.length, 1);
  });

  // 4. Remove cleanup test
  await t.test("POST /api/remove should clean up worker and metadata", async () => {
    // Before remove, term-1 is tracked
    const workersBefore = await request("GET", "/api/workers");
    const term1Worker = workersBefore.body.find(w => w.sessionName === "term-1");
    assert.ok(term1Worker);
    const term1Id = term1Worker.id;

    // Remove term-1
    const removeRes = await request("POST", "/api/remove", { id: term1Id });
    assert.equal(removeRes.status, 200);
    assert.equal(removeRes.body.ok, true);

    // After remove, term-1 should not be in the workers list
    const workersAfter = await request("GET", "/api/workers");
    const term1WorkerAfter = workersAfter.body.find(w => w.sessionName === "term-1");
    assert.equal(term1WorkerAfter, undefined);

    // Since term-1 is no longer in workers list but is still returned by tmux ls,
    // it should now show up in scan results!
    const scanRes = await request("GET", "/api/scan");
    const names = scanRes.body.map(s => s.sessionName);
    assert.ok(names.includes("term-1"));
  });

  // 5. Reset test
  await t.test("POST /api/reset should reset worker monitoring state and re-catch", async () => {
    // Let's reset term-2
    const workersList = await request("GET", "/api/workers");
    const term2Worker = workersList.body.find(w => w.sessionName === "term-2");
    assert.ok(term2Worker);
    const term2Id = term2Worker.id;

    // Call reset
    const resetRes = await request("POST", "/api/reset", { id: term2Id });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.ok, true);

    // Get workers again and check if it was reset
    const workersAfter = await request("GET", "/api/workers");
    const term2WorkerAfter = workersAfter.body.find(w => w.sessionName === "term-2");
    assert.ok(term2WorkerAfter);
    assert.equal(term2WorkerAfter.status, "running");
    assert.equal(term2WorkerAfter.aiState || null, null);
  });

  // 6. Security Headers test
  await t.test("HTTP responses should include security headers", async () => {
    const res = await request("GET", "/");
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer-when-downgrade");
  });

  // 7. Git diff path traversal security test
  await t.test("GET /api/git-diff should block paths outside the working directory", async () => {
    const workersList = await request("GET", "/api/workers");
    const term2Worker = workersList.body.find(w => w.sessionName === "term-2");
    assert.ok(term2Worker);
    const term2Id = term2Worker.id;

    // Attempt traversal path
    const res = await request("GET", `/api/git-diff?id=${term2Id}&file=/etc/passwd`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid file path");

    const res2 = await request("GET", `/api/git-diff?id=${term2Id}&file=../../passwd`);
    assert.equal(res2.status, 400);
    assert.equal(res2.body.error, "invalid file path");

    // Prefix collision path: previously could bypass startsWith() checks.
    const res3 = await request("GET", `/api/git-diff?id=${term2Id}&file=../2-sibling/path.txt`);
    assert.equal(res3.status, 400);
    assert.equal(res3.body.error, "invalid file path");
  });

  // 8. Input payload validation test
  await t.test("POST /api/input should reject malformed payloads", async () => {
    const workersRes = await request("GET", "/api/workers");
    assert.equal(workersRes.status, 200);
    const worker = workersRes.body.find(w => w.sessionName === "term-2");
    assert.ok(worker);

    const badText = await request("POST", "/api/input", { id: worker.id, text: { nope: true } });
    assert.equal(badText.status, 400);
    assert.equal(badText.body.error, "invalid input payload");

    const badId = await request("POST", "/api/input", { id: null, text: "echo hello" });
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error, "invalid input payload");
  });
});
