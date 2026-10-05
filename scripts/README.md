# Repository and historical tools

Normal development uses the npm scripts documented in the root README.
`reference-assets.mjs` downloads or checks the three pinned official runtime
inputs. `source-export.mjs` produces a source-only directory from tracked files.
Backup, restore and deployment utilities are covered by the operations runbooks.

## Optional historical PDF tools

The `ucm25_*.py` tools reconstruct and compare a specific historical report.
They are not required for application startup or the npm test suite. Supply
only input files you are authorized to use; private reports and extracted data
are excluded from the repository. Preserve the source-hash checks.

Use Python 3.11 or newer in a virtual environment:

```sh
python3 -m venv tmp/python-tools
. tmp/python-tools/bin/activate
python -m pip install -r scripts/requirements.txt
python -m unittest discover -s scripts -p 'test_ucm25*.py'
```

Use each tool's `--help` for input/output arguments. Write generated files under
ignored `tmp/` or `output/`. See `ucm25-pdf-parity.md` for an optional comparison
workflow. Tests construct synthetic records and do not require the team report.
