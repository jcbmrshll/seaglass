"""The `seaglass` command.

seaglass serve --dir runs --host 127.0.0.1 --port 8008
seaglass conformance http://localhost:8008
"""

import argparse
import os
import sys


def serve(args: argparse.Namespace) -> int:
    from seaglass.server import make_server

    server = make_server(args.host, args.port, args.dir)
    host, port = server.server_address[:2]
    print(f"seaglass on http://{host}:{port}  (runs in {os.path.abspath(args.dir)})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def conformance(args: argparse.Namespace) -> int:
    from seaglass.conformance import run_suite

    return 0 if run_suite(args.url, pattern=args.k, verbose=args.verbose) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="seaglass", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("serve", help="serve runs and the frontend")
    p.add_argument("--dir", default="runs", help="where runs are stored (runs)")
    p.add_argument("--host", default="127.0.0.1", help="address to listen on")
    p.add_argument("--port", type=int, default=8008, help="port (8008)")
    p.set_defaults(fn=serve)

    p = sub.add_parser("conformance", help="check a server against the protocol")
    p.add_argument("url", help="the server, e.g. http://localhost:8008")
    p.add_argument("-k", help="only cases whose name contains this")
    p.add_argument("-v", "--verbose", action="store_true", help="name every case")
    p.set_defaults(fn=conformance)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
