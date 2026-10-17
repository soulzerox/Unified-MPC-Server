/* global process */
// A child MCP server that dies the way the native Thai-RAG worker died in
// production: a fatal native-style failure with a diagnostic on stderr and a
// non-zero exit, so the host must surface the reason instead of a bare
// "Connection closed".
process.stderr.write('native worker exploded: simulated native fault\n');
process.exit(1);
