#!/usr/bin/env python3
"""Run with python3 test/chat-topic-focus.browser.py (requires Playwright and Chromium)."""
import asyncio
import json
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1] / 'public'
SEED = {'chats': [{
    'id': 'focus-regression', 'title': 'Study of black holes', 'titleReady': True,
    'subject': 'Space & Physics', 'subjectReady': True, 'createdAt': 1, 'updatedAt': 100,
    'messages': [{'type': 'user', 'text': 'How do black holes bend light?'},
                 {'type': 'ai', 'text': 'Their gravity curves spacetime.'}]
}], 'activeChatId': 'focus-regression'}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/'
    passed = []

    def check(device, name, ok, details=None):
        if not ok:
            raise AssertionError(f'{device}: {name}: {details}')
        passed.append(f'{device}: {name}')
        print(f'PASS: {device}: {name}', flush=True)

    async def mock_api(route):
        await route.fulfill(status=200, content_type='application/json', body='{}')

    async def edit(page, field, value):
        element_id = 'chatTopicHeroTitleText' if field == 'title' else 'chatTopicHeroSubject'
        old_value = (await page.locator(f'#{element_id}').text_content() or '').strip()
        button = page.get_by_role('button', name=f'Edit conversation {field}: {old_value}', exact=True)
        await button.click()
        editor = page.locator(f'#{element_id}')
        await page.get_by_role('textbox', name=f'Conversation {field}: {old_value}', exact=True).wait_for()
        await editor.fill(value)
        await page.get_by_role('textbox', name=f'Conversation {field}: {value}', exact=True).wait_for()
        return editor

    try:
        async with async_playwright() as playwright:
            chromium = os.environ.get('CHROMIUM_BINARY', '/usr/bin/chromium')
            browser = await playwright.chromium.launch(headless=True, executable_path=chromium,
                args=['--no-sandbox', '--disable-dev-shm-usage'])
            for device, width, height, mobile in [('desktop', 1365, 900, False), ('phone', 390, 844, True)]:
                context = await browser.new_context(viewport={'width': width, 'height': height},
                    device_scale_factor=1, is_mobile=mobile, has_touch=mobile)
                await context.add_init_script(f'''(() => {{
                    localStorage.setItem('knowura_guest_chats', JSON.stringify({json.dumps(SEED)}));
                    localStorage.setItem('knowura_settings', JSON.stringify({{resumeChat:'last'}}));
                    localStorage.setItem('knowura_intro_seen_v1','1');
                    localStorage.setItem('knowura_cookie_ack','1');
                }})();''')
                page = await context.new_page()
                await page.route('https://accounts.google.com/**', lambda route: route.abort())
                await page.route('**/.netlify/functions/**', mock_api)
                await page.goto(url, wait_until='domcontentloaded')
                await page.wait_for_function('typeof enterApp === "function" && typeof renderActiveChat === "function"')
                if not await page.locator('#app').is_visible():
                    await page.evaluate('enterApp("Guest")')
                await page.wait_for_function("document.getElementById('app').style.opacity === '1'")
                await page.locator('.chat-topic-hero').wait_for(state='visible')

                title = page.get_by_role('button', name='Edit conversation title: Study of black holes', exact=True)
                subject = page.get_by_role('button', name='Edit conversation subject: Space & Physics', exact=True)
                check(device, 'title and subject controls have accessible names',
                      await title.count() == 1 and await subject.count() == 1)

                editor = await edit(page, 'subject', 'Space & Physics')
                await editor.press('Tab')
                check(device, 'Tab from subject keeps the title control focused',
                      await title.evaluate('(element) => element === document.activeElement'))

                editor = await edit(page, 'title', 'Study of black holes')
                await editor.press('Shift+Tab')
                check(device, 'Shift+Tab from title keeps the subject control focused',
                      await subject.evaluate('(element) => element === document.activeElement'))

                editor = await edit(page, 'subject', 'Space & Physics')
                outside = page.locator('#userInput')
                await outside.click()
                check(device, 'clicking outside keeps focus on the outside control',
                      await outside.evaluate('(element) => element === document.activeElement'))
                check(device, 'outside blur commits and closes the subject editor',
                      await page.evaluate("getActiveChat().subject === 'Space & Physics' && !document.querySelector('.chat-topic-hero-edit-input')"))

                editor = await edit(page, 'title', 'Committed by Enter')
                await editor.press('Enter')
                enter_button = page.get_by_role('button', name='Edit conversation title: Committed by Enter', exact=True)
                check(device, 'Enter commits and restores focus to the title control',
                      await enter_button.evaluate('(element) => element === document.activeElement'))

                editor = await edit(page, 'subject', 'Canceled by Escape')
                await editor.press('Escape')
                subject_button = page.get_by_role('button', name='Edit conversation subject: Space & Physics', exact=True)
                check(device, 'Escape cancels and restores focus to the subject control',
                      await subject_button.evaluate('(element) => element === document.activeElement') and
                      await page.evaluate("getActiveChat().subject === 'Space & Physics'"))
                await context.close()
            await browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f'PASS: {len(passed)} desktop/phone browser regressions', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
