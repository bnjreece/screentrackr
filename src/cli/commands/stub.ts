/** Commands registered before they are built: each says so and exits 1, so a script never mistakes one for success. */
import { UserError } from '../context.js';

export function notBuiltYet(name: string): never {
  throw new UserError(`\`screentrackr ${name}\` is not built yet.`);
}
