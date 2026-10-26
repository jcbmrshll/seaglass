"""Writes the .npz files tests/js/npz.test.mjs decodes, and what they hold.

uv run python tests/js/fixtures/make_npz.py
"""

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent

ARRAYS = {
    "f4": np.array([[1.5, -2.25], [3.0, np.inf]], np.float32),
    "f8": np.array([0.1, 1e300]),
    "f2": np.array([1.0, -0.5, 65504, 6e-8], np.float16),
    "i4": np.arange(-3, 3, dtype=np.int32).reshape(2, 3),
    "i2": np.array([-32768, 32767], np.int16),
    "i1": np.array([-128, 127], np.int8),
    "u1": np.array([0, 255], np.uint8),
    "u2": np.array([65535], np.uint16),
    "u4": np.array([4294967295], np.uint32),
    "i8": np.array([-(2**40), 2**40], np.int64),
    "b1": np.array([True, False, True]),
    "scalar": np.float32(7.5),
    "empty": np.zeros((0, 3), np.float32),
    "big": np.arange(5000, dtype=np.int32),
}


def main() -> None:
    np.savez_compressed(HERE / "compressed.npz", **ARRAYS)  # pyright: ignore[reportArgumentType]
    np.savez(HERE / "stored.npz", **ARRAYS)  # pyright: ignore[reportArgumentType]
    expected = {
        name: {
            "shape": list(np.shape(a)),
            # as JSON can say them: infinities as strings, int64 as strings
            "values": [
                str(v) if not np.isfinite(v) or np.asarray(a).dtype == np.int64 else v
                for v in np.asarray(a).ravel()[:20].tolist()
            ],
        }
        for name, a in ARRAYS.items()
    }
    (HERE / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")


if __name__ == "__main__":
    main()
