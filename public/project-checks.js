const labels = {running: '测试中', passed: '测试通过', failed: '测试失败', stopped: '测试已停止'};

export function mountProjectChecks(mount) {
  mount.hidden = true;
  mount.innerHTML =
    '<div class="test-actions"><button type="button" data-run>运行 npm test</button><details><summary>测试输出</summary><pre tabindex="0"></pre></details><span role="status"></span></div>';
  const action = mount.querySelector('[data-run]');
  const details = mount.querySelector('details');
  const output = mount.querySelector('pre');
  const status = mount.querySelector('[role=status]');
  let id,
    piStatus,
    run,
    timer,
    generation = 0,
    pending = false;

  function show(data) {
    run = data.run;
    const running = run?.status === 'running';
    mount.hidden = !data.available && !run;
    action.textContent = running ? '停止测试' : '运行 npm test';
    action.disabled = pending || (!running && (!data.available || piStatus === 'running'));
    action.title = running
      ? '结束当前测试'
      : '在项目目录以当前用户身份执行 npm test' + (data.script ? '\n' + data.script : '');
    details.hidden = !run;
    output.textContent = run?.output || (running ? '测试已开始，输出会显示在这里…' : '这次运行没有打印任何内容。');
    status.dataset.result = run?.status || '';
    status.textContent = run
      ? labels[run.status] +
        (run.status === 'failed' && Number.isInteger(run.exitCode) ? ' · 退出码 ' + run.exitCode : '')
      : '';
  }
  async function update(method = 'GET') {
    clearTimeout(timer);
    if (!id) return;
    const version = ++generation;
    const running = run?.status === 'running';
    const write = method === 'POST';
    if (write) {
      pending = true;
      action.disabled = true;
    }
    try {
      const res = await fetch(
        '/api/studio/projects/' + encodeURIComponent(id) + '/checks' + (write && running ? '/stop' : ''),
        {
          method,
          cache: 'no-store',
          ...(write && {
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(running ? {} : {command: 'npm test'})
          })
        }
      );
      const data = await res.json();
      if (version !== generation) return;
      if (!res.ok) throw new Error(data.error || '测试状态读取失败。');
      pending = false;
      show(data);
      if (write && !running) details.open = true;
      if (run?.status === 'running') timer = setTimeout(() => update(), 850);
    } catch (error) {
      if (version !== generation) return;
      pending = false;
      action.disabled = false;
      status.textContent = error.message;
      if (!write && running) timer = setTimeout(() => update(), 1800);
    }
  }
  action.addEventListener('click', () => update('POST'));
  document.addEventListener('taskbench:session', ({detail}) => {
    if (id === detail.id && piStatus === detail.status) return;
    piStatus = detail.status;
    if (id !== detail.id) {
      id = detail.id;
      generation++;
      clearTimeout(timer);
      mount.hidden = true;
      details.open = false;
      pending = false;
      run = null;
    }
    if (!pending) void update();
  });
}
