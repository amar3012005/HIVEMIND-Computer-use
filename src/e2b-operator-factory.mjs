/**
 * E2B implementation of the ComputerRunExecutor injection points. The host
 * only leases a disposable desktop and reads one structured worker result;
 * the DOM observe-decide-act loop runs inside the desktop beside Chrome.
 */
export function createE2BOperatorFactories({ Sandbox, template, jevConfig = null, commandTimeoutMs = 15 * 60_000 } = {}) {
  if (!Sandbox?.create) throw new TypeError('E2B Sandbox.create is required')
  if (!template) throw new TypeError('E2B template is required')

  const computerFactory = async ({ run }) => {
    const desktop = await Sandbox.create(template, {
      allowInternetAccess: true,
      timeoutMs: commandTimeoutMs,
      requestTimeoutMs: 60_000,
      metadata: { app: 'hivemind', computer_run_id: String(run.computer_run_id ?? run.id) },
    })
    const chrome = await desktop.commands.run(
      'google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/home/user/hm-computer-worker/chrome-profile --no-first-run --no-default-browser-check about:blank >/tmp/hm-computer-chrome.log 2>&1',
      { background: true, timeoutMs: commandTimeoutMs, envs: { DISPLAY: ':0' } },
    )
    const ready = await desktop.waitAndVerify(
      'curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:9222/json/version >/dev/null',
      result => (result.exitCode ?? result.exit_code) === 0,
      30,
      1,
    )
    if (!ready) {
      await chrome?.kill?.().catch(() => {})
      await desktop.kill().catch(() => {})
      throw new Error('computer_chrome_cdp_unavailable')
    }
    return { sandboxId: desktop.sandboxId, desktop, chrome, destroy: async () => {
      await chrome?.kill?.().catch(() => {})
      await desktop.kill().catch(() => {})
    } }
  }

  const operatorFactory = async ({ run, computer }) => ({
    run: async () => {
      const requestedTimeoutMs = Number(run.limits?.timeout_ms ?? run.limits?.timeoutMs ?? 120_000)
      const workerTimeoutSecs = Math.min(Math.ceil(requestedTimeoutMs / 1000) + 15, 900)
      const inputPath = '/home/user/hm-computer-worker/run-input.json'
      await computer.desktop.files.write(inputPath, JSON.stringify({
        computer_run_id: String(run.computer_run_id ?? run.id),
        objective: run.objective,
        allowed_domains: run.allowed_domains,
        browser_plan: run.browser_plan,
        limits: { maxSteps: Number(run.limits?.max_steps ?? run.limits?.maxSteps ?? 12), timeoutMs: Number(run.limits?.timeout_ms ?? run.limits?.timeoutMs ?? 120000) },
      }))
      const worker = await computer.desktop.commands.run(
        `set +e; timeout --signal=TERM --kill-after=5s ${workerTimeoutSecs}s node executor.mjs >/tmp/hm-computer-worker.log 2>&1; status=$?; cat /tmp/hm-computer-worker.log; printf "\\n__HM_WORKER_EXIT=%s\\n" "$status"; exit 0`,
        {
          cwd: '/home/user/hm-computer-worker', timeoutMs: Math.min(commandTimeoutMs, (workerTimeoutSecs + 20) * 1000),
          envs: {
            DISPLAY: ':0', HM_CDP_ENDPOINT: 'http://127.0.0.1:9222', HM_COMPUTER_RUN_INPUT_PATH: inputPath,
            ...(jevConfig?.mode === 'direct-development' ? {
              HM_JEV_ENABLED: '1', HM_JEV_DEV_DIRECT: '1', HM_JEV_DECISIONS_URL: jevConfig.decisionsUrl,
              HM_JEV_API_KEY: jevConfig.apiKey, HM_JEV_HTTP_REFERER: jevConfig.httpReferer,
              HM_JEV_TITLE: jevConfig.title, HM_JEV_MODEL: jevConfig.model,
            } : jevConfig ? {
              HM_JEV_ENABLED: '1', HM_JEV_DECISIONS_URL: jevConfig.decisionsUrl,
              HM_JEV_GATEWAY_TOKEN: jevConfig.gatewayToken, HM_JEV_BYOK_ALIAS: jevConfig.byokAlias,
              HM_JEV_MODEL: jevConfig.model,
            } : {}),
          },
        },
      )
      const output = String(worker.stdout || '')
      const exitMarker = output.match(/__HM_WORKER_EXIT=(\d+)/)?.[1]
      const exit = Number(exitMarker ?? worker.exitCode ?? worker.exit_code ?? 0)
      const lines = output.trim().split('\n')
      const result = lines.map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(value => value?.status).at(-1)
      if (!result || exit !== 0) {
        const diagnosticLines = output.split('\n').filter(line => /^(?:Error|TypeError|ReferenceError|SyntaxError|Cannot|node:|\s+at |.*ERR_[A-Z_]+)/.test(line))
        const diagnostic = (diagnosticLines.length ? diagnosticLines.slice(0, 5) : output.split('\n').filter(Boolean).slice(-8)).join(' ').slice(0, 300)
        throw new Error(`computer_worker_exit_${Number.isInteger(exit) ? exit : 'unknown'}:${diagnostic || 'no_structured_result'}`)
      }
      return result
    },
  })

  return { computerFactory, operatorFactory }
}
