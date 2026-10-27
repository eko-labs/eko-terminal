import { SHELL_COPY } from '../copy/shell';
import { focusMain } from '../lib/mainFocus';

export function SkipLink() {
  return <a className="skip" href="#main" onClick={event => {
    event.preventDefault();
    focusMain();
  }}>{SHELL_COPY.skip}</a>;
}
