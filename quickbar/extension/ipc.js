// Link from the shell extension to the quick bar daemon (one JSON object per line over a Unix
// socket). The daemon is started on demand and is the only place that does heavy work.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const CONNECT_RETRIES = 40;
const CONNECT_RETRY_MS = 75;

export function readOwnConfig() {
    try {
        const file = GLib.build_filenamev([GLib.get_home_dir(), '.friday', 'quickbar.json']);
        const [ok, bytes] = GLib.file_get_contents(file);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : {};
    } catch {
        return {};
    }
}

function findNode(config) {
    const candidates = [config.node, '/usr/local/bin/node', '/usr/bin/node'];
    const nvm = GLib.build_filenamev([GLib.get_home_dir(), '.nvm', 'versions', 'node']);
    try {
        const dir = Gio.File.new_for_path(nvm);
        const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        let info;
        while ((info = en.next_file(null)) !== null) names.push(info.get_name());
        names.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
        for (const n of names) candidates.push(GLib.build_filenamev([nvm, n, 'bin', 'node']));
    } catch {
        // no nvm
    }
    return candidates.find(p => p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? 'node';
}

export class DaemonLink {
    /** @param {(event: object) => void} onEvent @param {(msg: string) => void} log */
    constructor(onEvent, log = () => {}) {
        this._onEvent = onEvent;
        this._log = log;
        this._conn = null;
        this._input = null;
        this._cancellable = null;
        this._connecting = null;
        this.socketPath = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'friday-quickbar.sock']);
    }

    get connected() {
        return !!this._conn;
    }

    _spawnDaemon() {
        const config = readOwnConfig();
        const repo = config.repoDir;
        if (!repo) {
            this._log('quickbar: ~/.friday/quickbar.json has no repoDir; run the installer');
            return;
        }
        const script = GLib.build_filenamev([repo, 'quickbar', 'daemon', 'daemon.mjs']);
        try {
            Gio.Subprocess.new([findNode(config), script], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._log(`quickbar: could not start the daemon: ${e.message}`);
        }
    }

    _tryConnect() {
        return new Promise(resolve => {
            const client = new Gio.SocketClient();
            const address = new Gio.UnixSocketAddress({path: this.socketPath});
            client.connect_async(address, this._cancellable, (c, res) => {
                try {
                    resolve(c.connect_finish(res));
                } catch {
                    resolve(null);
                }
            });
        });
    }

    /** Connects, starting the daemon first if it is not running. Resolves true when connected. */
    connect() {
        if (this._conn) return Promise.resolve(true);
        if (this._connecting) return this._connecting;
        this._cancellable = new Gio.Cancellable();
        this._connecting = (async () => {
            let conn = await this._tryConnect();
            if (!conn) {
                this._spawnDaemon();
                for (let i = 0; i < CONNECT_RETRIES && !conn; i++) {
                    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONNECT_RETRY_MS, () => (r(), GLib.SOURCE_REMOVE)));
                    if (this._cancellable?.is_cancelled()) return false;
                    conn = await this._tryConnect();
                }
            }
            if (!conn) return false;
            this._conn = conn;
            this._input = new Gio.DataInputStream({base_stream: conn.get_input_stream(), close_base_stream: false});
            this._readLoop();
            return true;
        })().finally(() => {
            this._connecting = null;
        });
        return this._connecting;
    }

    _readLoop() {
        const input = this._input;
        if (!input) return;
        input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                line = null;
            }
            if (line === null) {
                this._drop();
                this._onEvent({ev: 'disconnected'});
                return;
            }
            try {
                this._onEvent(JSON.parse(line));
            } catch (e) {
                this._log(`quickbar: bad event: ${e.message}`);
            }
            this._readLoop();
        });
    }

    _drop() {
        try {
            this._conn?.close(null);
        } catch {
            // already closed
        }
        this._conn = null;
        this._input = null;
    }

    send(msg) {
        if (!this._conn) return false;
        try {
            const data = new TextEncoder().encode(`${JSON.stringify(msg)}\n`);
            this._conn.get_output_stream().write_all(data, null);
            return true;
        } catch (e) {
            this._log(`quickbar: send failed: ${e.message}`);
            this._drop();
            return false;
        }
    }

    destroy() {
        this._cancellable?.cancel();
        this._drop();
    }
}
