const input = document.querySelector('#enabled');
const status = document.querySelector('#status');

async function render() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  input.checked = enabled !== false;
  status.textContent = input.checked
    ? '遇到重复页面时会先询问。'
    : '已暂停。再次打开相同页面不会询问。';
}

input.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: input.checked });
  await render();
});

document.querySelector('#settings').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
});

render();
