import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks';
import { OBSWebSocket } from 'obs-websocket-js';
import type { OBSResponseTypes, RequestBatchRequest, ResponseMessage } from 'obs-websocket-js';

import './main.css'
import { fileSize } from 'humanize-plus';

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
  status: Status;
  prevStatus: Status;
};

// interface FrameOffset {
//   renderSkippedFrames: number;
//   renderTotalFrames: number;
//   outputSkippedFrames: number;
//   outputTotalFrames: number;
//   outputs: Record<string, {
//     outputSkippedFrames: number;
//     outputTotalFrames: number;
//   }>;
// }

const THRESHOLD_WARNING = 0.01;
const THRESHOLD_CRITICAL = 0.05;
const POLLING_INTERVAL = 2000;
const nullStatus: Status = {
  stats: {
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
  },
  outputs: [],
};
const nullOutputStatus: OutputStatus = {
  outputActive: false,
  outputReconnecting: false,
  outputTimecode: '00:00:00.000',
  outputDuration: 0,
  outputCongestion: 0,
  outputBytes: 0,
  outputSkippedFrames: 0,
  outputTotalFrames: 0,
};
const outputNameMapping: Record<string, string> = {
  'simple_stream': 'Stream',
  'adv_stream': 'Stream',
  'simple_file_output': 'Recording',
  'adv_file_output': 'Recording',
  'virtualcam_output': 'Virtual Cam',
};

// get password from query params
const urlParams = new URLSearchParams(window.location.search);
const password = urlParams.get('password') || '';

const obs = new OBSWebSocket();
await obs.connect('ws://127.0.0.1:4455', password);

render((<App obs={obs} />), document.body);

function App({ obs }: { obs: OBSWebSocket }) {
  const state = useStatus(obs);
  return (
    <>
      <ObsStats stats={state.status.stats} prevStats={state.prevStatus.stats} />
      <OutputsTable outputs={state.status.outputs} prevOutputs={state.prevStatus.outputs} />
    </>
  );
}

function ObsStats({
  stats,
  // prevStats,
}: {
  stats: ObsStatus,
  prevStats: ObsStatus,
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
          <div class="stat">
            <span class="stat__name">Render frames missed:</span>
            {' '}
            <span class={`stat__value ${renderFramesClass}`}>{renderFramesText}</span>
          </div>
          <div class="stat">
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
      console.log('Resizing table');
      if (!containerRef.current) {
        return;
      }
      const bodyElem = containerRef.current.querySelector('tbody');
      const rowElems = containerRef.current.querySelectorAll('tbody tr');
      const rowNum = rowElems.length;
      console.log(`Row num: ${rowNum}`);
      if (!bodyElem || rowNum === 0) {
        setRowSplit(0);
        return;
      }
      const rowHeight = rowElems[0].clientHeight;
      const rowWidth = bodyElem.clientWidth;
      console.log(`Row height: ${rowHeight}, container height: ${containerRef.current.clientHeight}`);
      console.log(`Row width: ${rowWidth}, container width: ${containerRef.current.clientWidth}`);
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

  console.log(`Row split: ${rowSplit}`);
  const rows = outputs.map(o => {
    const prevStatus = prevOutputs.find(p => p.name === o.name)
      || { name: o.name, status: nullOutputStatus };
    return (<OutputStats stats={o} prevStats={prevStatus} />);
  });

  return <div class="outputs" ref={containerRef}>
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
        {rowSplit > 0 ? rows.slice(0, rowSplit) : rows}
      </tbody>
      { rowSplit > 0 && <tbody>
        {rows.slice(rowSplit)}
      </tbody> }
    </table>
  </div>;
}

/**
 * @param {{
 *  status: Output,
 *  prevStatus: Output,
 * }} params
 */
function OutputStats({
  stats,
  prevStats,
}: {
  stats: Output,
  prevStats: Output,
}) {
  const active = stats.status.outputActive;
  const reconnecting = stats.status.outputReconnecting;
  const skippedFrames = stats.status.outputSkippedFrames;
  const totalFrames = stats.status.outputTotalFrames;
  const name = outputNameMapping[stats.name] || stats.name;
  const { counterText, counterClass } = frameCounter(totalFrames, skippedFrames);
  const bytes = fileSize(stats.status.outputBytes);
  const bitsSinceLastPoll = (stats.status.outputBytes - prevStats.status.outputBytes) * 8;
  const bitrate = `${(bitsSinceLastPoll / POLLING_INTERVAL).toFixed(0)} kb\u2060/\u2060s`;
  const droppedFrames = skippedFrames > prevStats.status.outputSkippedFrames;
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
  const [status, setStatus] = useState<Status>(nullStatus);
  const [prevStatus, setPrevStatus] = useState<Status>(nullStatus);
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

