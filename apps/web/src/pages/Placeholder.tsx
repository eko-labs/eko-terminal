import { Collapsible } from '../components/ui';
import { SHELL_COPY } from '../copy/shell';
export default function Placeholder({ title, params }: { title: string; params: Record<string, string> }) {
  return <div className="shell-page"><div className="page-head"><span className="eyebrow">{title}</span><h1>{title}</h1><p>{SHELL_COPY.preview}</p></div>
    {Object.entries(params).map(([key, value]) => <p className="route-param num" key={key}>{value}</p>)}
    <Collapsible id={`shell-${title}`} title={SHELL_COPY.how}><p className="shell-note">{SHELL_COPY.skeleton}</p></Collapsible>
  </div>;
}
