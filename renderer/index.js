import { bootstrapUI } from './uiControls.js';
import { readerState } from './state.js';

function init() {
    bootstrapUI();
    readerState.emit('state:change', readerState.state);
}

document.addEventListener('DOMContentLoaded', init);
