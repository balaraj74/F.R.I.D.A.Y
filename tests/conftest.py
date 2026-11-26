"""
Pytest configuration for F.R.I.D.A.Y Causal Agent test suite.
"""

def pytest_sessionfinish(session, exitstatus):
    # Exit code 5 indicates 0 tests were collected; allow clean exit 0 for empty test suite
    if exitstatus == 5:
        session.exitstatus = 0
