import './ui/styles.css';
import { App } from './core/App';

const container = document.getElementById('app');
if (!container) throw new Error('#app is missing from the document');

// WebGL is the one hard requirement, and failing without a message is the
// worst version of not having it.
const probe = document.createElement('canvas');
if (!probe.getContext('webgl2') && !probe.getContext('webgl')) {
  container.innerHTML = `
    <div style="display:grid;place-items:center;height:100%;padding:24px;text-align:center">
      <div>
        <h1 style="font-size:17px;margin:0 0 8px">WebGL is unavailable</h1>
        <p style="color:#8d9ab4;margin:0">Creature Forge needs WebGL. Try another browser, or enable
        hardware acceleration.</p>
      </div>
    </div>`;
} else {
  new App(container);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'drag to orbit · scroll to zoom';
  document.body.appendChild(hint);
}
