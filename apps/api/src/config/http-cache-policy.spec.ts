import * as fs from 'node:fs';
import * as path from 'node:path';

describe('dynamic API HTTP cache policy', () => {
  it('disables Express ETags so authenticated JSON reads cannot become empty 304 responses', () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');

    expect(mainSource).toContain("expressApp.disable('etag')");
  });
});
