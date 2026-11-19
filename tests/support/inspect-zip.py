"""Open a ZIP with an implementation that did not write it.

Reading the archive back with the library that produced it would prove only
that it agrees with itself. Python's zipfile follows the same specification
Excel, Finder and File Explorer do, so if this can open it, they can.

Prints JSON: the names, whole contents for small files, and a shape (line
count, first and last line) for every file — because piping a multi-megabyte
CSV back through stdout overflows the caller's buffer.
"""

import json
import sys
import zipfile

LIMIT = 64 * 1024

with zipfile.ZipFile(sys.argv[1]) as archive:
    corrupt = archive.testzip()

    contents = {}
    shapes = {}

    for name in archive.namelist():
        text = archive.read(name).decode("utf-8-sig")
        lines = text.split("\r\n")
        shapes[name] = {
            "lines": len(lines),
            "first": lines[0] if lines else "",
            "last": lines[-2] if len(lines) > 1 else "",
        }
        if len(text) <= LIMIT:
            contents[name] = text

    print(
        json.dumps(
            {
                "names": archive.namelist(),
                "contents": contents,
                "shapes": shapes,
                "ok": corrupt is None,
            }
        )
    )
