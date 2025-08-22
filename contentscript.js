chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'start') bot.start(msg.limite, msg.minDelay, msg.maxDelay);
    if (msg.action === 'stop') bot.stop();
    if (msg.type === 'AF_RESUME') bot.onResume();
});
