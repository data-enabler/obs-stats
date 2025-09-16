import { fileSize } from 'humanize-plus';
import update from 'immutability-helper';
import { OBSWebSocket } from 'obs-websocket-js';
import type { OBSResponseTypes, RequestBatchRequest, ResponseMessage } from 'obs-websocket-js';
import { render } from 'preact'
import { useEffect, useRef, useState, type Dispatch, type StateUpdater } from 'preact/hooks';

import './main.css'

type ObsStatus = OBSResponseTypes['GetStats'];
type OutputStatus = OBSResponseTypes['GetOutputStatus'];

interface Output {
  name: string;
  status: OutputStatus;
};

interface Status {
  stats: ObsStatus;
  outputs: Output[];
};

interface State {
  status: Status | null;
  prevStatus: Status | null;
};

type ConnectionResult = [OBSWebSocket | null, string | null];

interface FrameOffset {
  renderSkippedFrames: number;
  renderTotalFrames: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
  outputs: Record<string, {
    outputSkippedFrames: number;
    outputTotalFrames: number;
  }>;
}

const THRESHOLD_WARNING = 0.01;
const THRESHOLD_CRITICAL = 0.05;
const POLLING_INTERVAL = 2000;
const nullObsStatus: ObsStatus = {
  cpuUsage: 0,
  memoryUsage: 0,
  availableDiskSpace: 0,
  activeFps: 0,
  averageFrameRenderTime: 0,
  renderSkippedFrames: 0,
  renderTotalFrames: 0,
  outputSkippedFrames: 0,
  outputTotalFrames: 0,
  webSocketSessionIncomingMessages: 0,
  webSocketSessionOutgoingMessages: 0,
};
const nullFrameOffset: FrameOffset = {
  renderSkippedFrames: 0,
  renderTotalFrames: 0,
  outputSkippedFrames: 0,
  outputTotalFrames: 0,
  outputs: {},
};
const outputNameMapping: Record<string, string> = {
  'simple_stream': 'Stream',
  'adv_stream': 'Stream',
  'simple_file_output': 'Recording',
  'adv_file_output': 'Recording',
  'virtualcam_output': 'Virtual Cam',
};

const urlParams = new URLSearchParams(window.location.search);
const urlAddress = urlParams.get('address') ?? localStorage.getItem('address');
const urlPassword = urlParams.get('password') ?? localStorage.getItem('password');
const theme = urlParams.get('theme') || 'default';
document.documentElement.classList.add(`theme-${theme}`);
document.body.style.setProperty('--poll-interval', `${POLLING_INTERVAL}ms`);

render(
  <App
    presetAddress={urlAddress}
    presetPassword={urlPassword}
  />,
  document.body,
);

function App({
  presetAddress,
  presetPassword,
}: {
  presetAddress: string | null,
  presetPassword: string | null,
}) {
  const shouldAutoConnect = presetAddress != null && presetPassword != null;
  const [obs, setObs] = useState<OBSWebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoConnecting, setAutoConnecting] = useState(shouldAutoConnect);

  useEffect(() => {
    if (shouldAutoConnect) {
      login(presetAddress, presetPassword)
        .then(([obs, err]) => {
          setObs(obs);
          setError(err);
          setAutoConnecting(false);
        });
    }
  }, [presetAddress, presetPassword]);

  if (autoConnecting) {
    return <></>;
  }

  return obs
    ? <Dashboard
      obs={obs}
      setObs={setObs}
    />
    : <LoginForm
      presetAddress={presetAddress}
      presetPassword={presetPassword}
      setObs={setObs}
      error={error}
      setError={setError}
    />;
}

async function login(
  address: string,
  password: string,
): Promise<ConnectionResult> {
  const obs = new OBSWebSocket();
  const addressUrl = new URL(address.includes('://') ? address : `ws://${address}`);
  return await obs.connect(addressUrl.href, password || undefined)
    .then((): ConnectionResult => {
      localStorage.setItem('address', address);
      localStorage.setItem('password', password);
      obs.on('ConnectionClosed', async () => {
        await delay(1000);
        await obs.connect(addressUrl.href, password || undefined);
      });
      return [obs, null];
    })
    .catch(err => {
      return [null, (err as Error).message];
    });
}

function LoginForm({
  presetAddress,
  presetPassword,
  setObs,
  error,
  setError,
}: {
  presetAddress: string | null,
  presetPassword: string | null,
  setObs: Dispatch<StateUpdater<OBSWebSocket | null>>,
  error: string | null,
  setError: Dispatch<StateUpdater<string | null>>,
}) {
  const [address, setAddress] = useState(presetAddress || 'localhost:4455');
  const [password, setPassword] = useState(presetPassword || '');
  const [showPassword, setShowPassword] = useState(false);

  async function attemptLogin(e: Event) {
    e.preventDefault();
    await login(address, password)
      .then(([obs, err]) => {
        setObs(obs);
        setError(err);
      });
  }
  function forget() {
    localStorage.removeItem('address');
    localStorage.removeItem('password');
    setAddress('');
    setPassword('');
  }

  return (
    <form class="login" onSubmit={attemptLogin}>
      {error && <div class="login__error" role="alert">{error}</div>}
      <label class="login__row login__field">
        {'Address: '}
        <input
          type="text"
          name="address"
          value={address}
          onInput={e => setAddress((e.target as HTMLInputElement).value)}
        />
      </label>
      <br />
      <div class="login__row">
        <label class="login__field">
          {'Password: '}
          <input
            type={showPassword ? 'text' : 'password'}
            name="password"
            value={password}
            onInput={e => setPassword((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="login__password-toggle">
          {'Show: '}
          <input
            type="checkbox"
            checked={showPassword}
            onChange={e => setShowPassword((e.target as HTMLInputElement).checked)}
          />
        </label>
      </div>
      <br />
      <div class="login__actions">
        <button type="button" onClick={forget}>Forget</button>
        <button type="submit">Connect</button>
      </div>
    </form>
  )
}

function Dashboard({
  obs,
  setObs,
}: {
  obs: OBSWebSocket,
  setObs: Dispatch<StateUpdater<OBSWebSocket | null>>,
}) {
  const state = useStatus(obs);
  const [offset, setOffset] = useState<FrameOffset>(nullFrameOffset);

  function disconnect() {
    obs.off('ConnectionClosed');
    obs.disconnect();
    setObs(null);
  }

  function reset() {
    setOffset({
      renderSkippedFrames: state.status?.stats.renderSkippedFrames || 0,
      renderTotalFrames: state.status?.stats.renderTotalFrames || 0,
      outputSkippedFrames: state.status?.stats.outputSkippedFrames || 0,
      outputTotalFrames: state.status?.stats.outputTotalFrames || 0,
      outputs: Object.fromEntries((state.status?.outputs || []).map(o => [
        o.name,
        {
          outputSkippedFrames: o.status.outputSkippedFrames,
          outputTotalFrames: o.status.outputTotalFrames,
        },
      ])),
    });
  }

  const {
    adjustedStats,
    adjustedPrevStats,
    adjustedOutputs,
    adjustedPrevOutputs,
  } = applyStatOffset(state, offset, setOffset);

  return (
    <>
      <ObsStats stats={adjustedStats} prevStats={adjustedPrevStats} />
      <OutputsTable outputs={adjustedOutputs} prevOutputs={adjustedPrevOutputs} />
      <button
        class="disconnect"
        onClick={disconnect}
        aria-label={'Disconnect'}
        title={'Disconnect'}
      >
        🔌
      </button>
      <button
        class="reset"
        onClick={reset}
        aria-label={'Reset'}
        title={'Reset'}
      >
        🔄
      </button>
    </>
  );
}

function applyStatOffset(
  state: State,
  offset: FrameOffset,
  setOffset: Dispatch<StateUpdater<FrameOffset>>,
): {
  adjustedStats: ObsStatus,
  adjustedPrevStats: ObsStatus | null,
  adjustedOutputs: Output[],
  adjustedPrevOutputs: Output[],
} {
  if (offset.renderTotalFrames &&
    (state.status?.stats.renderTotalFrames || 0) < (state.prevStatus?.stats.renderTotalFrames || 0)) {
    offset.renderSkippedFrames = 0;
    offset.renderTotalFrames = 0;
    setOffset(o => update(o, {
      renderSkippedFrames: { $set: 0 },
      renderTotalFrames: { $set: 0 },
    }));
  }
  if (offset.outputTotalFrames &&
    (state.status?.stats.outputTotalFrames || 0) < (state.prevStatus?.stats.outputTotalFrames || 0)) {
    offset.outputSkippedFrames = 0;
    offset.outputTotalFrames = 0;
    setOffset(o => update(o, {
      outputSkippedFrames: { $set: 0 },
      outputTotalFrames: { $set: 0 },
    }));
  }
  (state.status?.outputs || []).forEach(output => {
    const prevOutput = state.prevStatus?.outputs.find(p => p.name === output.name) || null;
    if (offset.outputs[output.name]?.outputTotalFrames &&
      output.status.outputTotalFrames < (prevOutput?.status.outputTotalFrames || 0)) {
      offset.outputs[output.name] = {
        outputSkippedFrames: 0,
        outputTotalFrames: 0,
      };
      setOffset(o => update(o, {
        outputs: {
          [output.name]: {
            $set: {
              outputSkippedFrames: 0,
              outputTotalFrames: 0,
            },
          },
        },
      }));
    }
  });

  const origStats = state.status?.stats || nullObsStatus;
  const adjustedStats: ObsStatus = {
    ...origStats,
    renderSkippedFrames: origStats.renderSkippedFrames - offset.renderSkippedFrames,
    renderTotalFrames: origStats.renderTotalFrames - offset.renderTotalFrames,
    outputSkippedFrames: origStats.outputSkippedFrames - offset.outputSkippedFrames,
    outputTotalFrames: origStats.outputTotalFrames - offset.outputTotalFrames,
  };
  const origPrevStats = state.prevStatus?.stats;
  const adjustedPrevStats: ObsStatus | null = origPrevStats ? {
    ...origPrevStats,
    renderSkippedFrames: origPrevStats.renderSkippedFrames - offset.renderSkippedFrames,
    renderTotalFrames: origPrevStats.renderTotalFrames - offset.renderTotalFrames,
    outputSkippedFrames: origPrevStats.outputSkippedFrames - offset.outputSkippedFrames,
    outputTotalFrames: origPrevStats.outputTotalFrames - offset.outputTotalFrames,
  } : null;
  const origOutputs = state.status?.outputs || [];
  const adjustedOutputs: Output[] = origOutputs.map(o => {
    const origOutputOffset = offset.outputs[o.name] || {
      outputSkippedFrames: 0,
      outputTotalFrames: 0,
    };
    return {
      name: o.name,
      status: {
        ...o.status,
        outputSkippedFrames: o.status.outputSkippedFrames - origOutputOffset.outputSkippedFrames,
        outputTotalFrames: o.status.outputTotalFrames - origOutputOffset.outputTotalFrames,
      },
    };
  });
  const origPrevOutputs = state.prevStatus?.outputs || [];
  const adjustedPrevOutputs: Output[] = origPrevOutputs.map(o => {
    const origOutputOffset = offset.outputs[o.name] || {
      outputSkippedFrames: 0,
      outputTotalFrames: 0,
    };
    return {
      name: o.name,
      status: {
        ...o.status,
        outputSkippedFrames: o.status.outputSkippedFrames - origOutputOffset.outputSkippedFrames,
        outputTotalFrames: o.status.outputTotalFrames - origOutputOffset.outputTotalFrames,
      },
    };
  });
  return { adjustedStats, adjustedPrevStats, adjustedOutputs, adjustedPrevOutputs };
}

function ObsStats({
  stats,
  prevStats,
}: {
  stats: ObsStatus,
  prevStats: ObsStatus | null,
}) {
  const cpuUsage = `${stats.cpuUsage.toPrecision(2)}%`;
  const memoryUsage = fileSize(stats.memoryUsage * 1024 * 1024);
  const diskSpace = fileSize(stats.availableDiskSpace * 1024 * 1024);
  const fps = stats.activeFps.toFixed(2);
  const frametime = `${stats.averageFrameRenderTime.toPrecision(3)} ms`;
  const {
    counterText: renderFramesText,
    counterClass: renderFramesClass,
  } = frameCounter(stats.renderTotalFrames, stats.renderSkippedFrames);
  const {
    counterText: encodeFramesText,
    counterClass: encodeFramesClass,
  } = frameCounter(stats.outputTotalFrames, stats.outputSkippedFrames);
  const renderFramesDropped = !!prevStats && stats.renderSkippedFrames > prevStats.renderSkippedFrames;
  const encodeFramesDropped = !!prevStats && stats.outputSkippedFrames > prevStats.outputSkippedFrames;
  return (
    <div class="stats">
      <section class="stats__section" aria-label="Resource Usage">
        <div class="stat">
          <span class="stat__name">CPU:</span> <span class="stat__value">{cpuUsage}</span>
        </div>
        <div class="stat">
          <span class="stat__name">Mem:</span> <span class="stat__value">{memoryUsage}</span>
        </div>
        <div class="stat">
          <span class="stat__name">Disk Space:</span> <span class="stat__value">{diskSpace}</span>
        </div>
      </section>
      <section class="stats__section" aria-label="Performance">
        <div class="stat">
          <span class="stat__name">FPS:</span> <span class="stat__value">{fps}</span>
        </div>
        <div class="stat">
          <span class="stat__name">Frametime:</span> <span class="stat__value">{frametime}</span>
        </div>
        <div class="stats__group">
          <div class={`stat ${renderFramesDropped ? 'frames--dropped' : ''}`}>
            <span class="stat__name">Render frames missed:</span>
            {' '}
            <span class={`stat__value ${renderFramesClass}`}>{renderFramesText}</span>
          </div>
          <div class={`stat ${encodeFramesDropped ? 'frames--dropped' : ''}`}>
            <span class="stat__name">Encoding frames missed:</span>
            {' '}
            <span class={`stat__value ${encodeFramesClass}`}>{encodeFramesText}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

function OutputsTable({
  outputs,
  prevOutputs,
}: {
  outputs: Output[],
  prevOutputs: Output[],
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rowSplit, setRowSplit] = useState(0);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    function resizeTable() {
      if (!containerRef.current) {
        return;
      }
      const bodyElem = containerRef.current.querySelector('tbody');
      const rowElems = containerRef.current.querySelectorAll('tbody tr');
      const rowNum = rowElems.length;
      if (!bodyElem || rowNum === 0) {
        setRowSplit(0);
        return;
      }
      const rowHeight = rowElems[0].clientHeight;
      const rowWidth = bodyElem.clientWidth;
      const isOverflowing = containerRef.current.clientHeight < rowHeight * rowNum;
      const canFitTwoCols = containerRef.current.clientWidth > rowWidth * 2;
      if (isOverflowing && canFitTwoCols) {
        setRowSplit(Math.ceil(rowNum / 2));
      } else {
        setRowSplit(0);
      }
    }
    resizeTable();
    const resizeObserver = new ResizeObserver(resizeTable);
    resizeObserver.observe(containerRef.current);
  }, [outputs.length]);

  const rows = outputs.map(o => {
    const prevStatus = prevOutputs.find(p => p.name === o.name) || null;
    return (<OutputStats stats={o} prevStats={prevStatus} />);
  });

  const groups = rowSplit > 0
    ? [rows.slice(0, rowSplit), rows.slice(rowSplit)]
    : [rows];

  return <div class="outputs" ref={containerRef}>
    {groups.map((group) => (
      <div class="outputs__table-container">
        <table>
          <thead class="sr-only">
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Output</th>
              <th scope="col">Frames (skipped/total)</th>
              <th scope="col">Data Output</th>
              <th scope="col">Bitrate</th>
            </tr>
          </thead>
          <tbody>
            {group}
          </tbody>
        </table>
      </div>
    ))}
  </div>;
}

function OutputStats({
  stats,
  prevStats,
}: {
  stats: Output,
  prevStats: Output | null,
}) {
  const active = stats.status.outputActive;
  const reconnecting = stats.status.outputReconnecting;
  const skippedFrames = stats.status.outputSkippedFrames;
  const totalFrames = stats.status.outputTotalFrames;
  const name = outputNameMapping[stats.name] || stats.name;
  const { counterText, counterClass } = frameCounter(totalFrames, skippedFrames);
  const bytes = fileSize(stats.status.outputBytes);
  const bitsSinceLastPoll = (prevStats && prevStats.status.outputBytes <= stats.status.outputBytes)
    ? (stats.status.outputBytes - prevStats.status.outputBytes) * 8
    : 0;
  const bitrate = `${(bitsSinceLastPoll / POLLING_INTERVAL).toFixed(0)} kb\u2060/\u2060s`;
  const droppedFrames = !!prevStats && skippedFrames > prevStats.status.outputSkippedFrames;
  return (
    <tr class={`output ${droppedFrames ? 'frames--dropped' : 'frames--normal'}`}>
      <td class={`output__status ${active ? 'output--active' : 'output--inactive'}`}>
        {reconnecting ? '⚠️' : (active ? '▶️' : '⏹️')}
      </td>
      <td class="output__name">{name}</td>
      <td class={`output__frames ${counterClass}`}>{counterText}</td>
      <td class="output__data">{bytes}</td>
      <td class="output__bitrate">{bitrate}</td>
    </tr>
  );
}

function frameCounter(totalFrames: number, skippedFrames: number) {
  const skippedRatio = totalFrames > 0 ? (skippedFrames / totalFrames) : 0;
  const counterClass = skippedRatio > THRESHOLD_CRITICAL ? 'lag--critical' :
    skippedRatio > THRESHOLD_WARNING ? 'lag--warning' : 'lag--normal';
  const counterText = `${skippedFrames}/${totalFrames} (${(skippedRatio * 100).toFixed(1)}%)`;
  return { counterText, counterClass };
}

function useStatus(obs: OBSWebSocket): State {
  // We can't get the outputlist and status in one batch call, so keep track of
  // the output names from the last request
  const outputNames = useRef<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [prevStatus, setPrevStatus] = useState<Status | null>(null);
  useEffect(() => {
    async function fetchStats() {
      if (outputNames.current.length === 0) {
        outputNames.current = parseOutputNames(await obs.call('GetOutputList'));
      }
      const outputRequests: RequestBatchRequest<'GetOutputStatus'>[] = outputNames.current
        .map(name => ({
          'requestType': 'GetOutputStatus',
          'requestData': { outputName: name },
        }));
      const resp = await obs.callBatch([
        { 'requestType': 'GetOutputList' },
        { 'requestType': 'GetStats' },
        ...outputRequests,
      ]);
      const outputListResp = resp[0] as ResponseMessage<'GetOutputList'>;
      const statsResp = resp[1] as ResponseMessage<'GetStats'>;
      const outputStatusResps = resp.slice(2) as ResponseMessage<'GetOutputStatus'>[];
      const state = {
        stats: statsResp.responseData,
        outputs: outputNames.current.map((name, i) => ({
          name,
          status: outputStatusResps[i].responseData,
        }))
          .filter(o => o.status),
      };

      // Technically this is succeptible to race conditions, but in practice
      // the websocket latency should never be higher than our polling interval
      setStatus(previous => {
        setPrevStatus(previous);
        return state;
      });
      outputNames.current = parseOutputNames(outputListResp.responseData);
    }
    fetchStats();
    const interval = setInterval(fetchStats, POLLING_INTERVAL);
    return () => clearInterval(interval);

  }, [obs]);
  return { status, prevStatus };
}

function parseOutputNames(
  outputListResp: OBSResponseTypes['GetOutputList'],
): string[] {
  return outputListResp.outputs.map(o => o.outputName as string);
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
