import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const ex = (name: string) => join(root, 'examples', name);
