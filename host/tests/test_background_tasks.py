import asyncio
import logging

from vibestick.daemon import BackgroundTasks


def test_background_task_failure_is_logged(caplog):
    async def fails():
        raise RuntimeError("expected failure")

    async def run():
        tasks = BackgroundTasks()
        tasks.spawn(fails(), name="test-failure")
        await asyncio.sleep(0)

    with caplog.at_level(logging.ERROR):
        asyncio.run(run())
    assert "background task test-failure failed" in caplog.text


def test_background_tasks_cancel_cleanly():
    async def waits():
        await asyncio.Event().wait()

    async def run():
        tasks = BackgroundTasks()
        tasks.spawn(waits(), name="test-wait")
        await asyncio.sleep(0)
        await tasks.cancel()

    asyncio.run(run())
