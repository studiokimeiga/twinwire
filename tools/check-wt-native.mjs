try {
  // The provider catches its own load failure; its quicheLoaded promise alone is not evidence.
  const native = await import('@fails-components/webtransport-transport-http3-quiche');
  if (typeof native.Http3WebTransportServer !== 'function') throw new Error('Native HTTP/3 implementation missing');
  console.log('native HTTP/3 constructor loaded (connection not yet tested)');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
