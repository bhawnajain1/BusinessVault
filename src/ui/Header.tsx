import { Link } from 'react-router-dom';
import CloudIndicator from './CloudIndicator';
import ThemeToggle from './theme/ThemeToggle';

export default function Header() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-4 h-12">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-medium text-fg hover:text-fg"
        aria-label="BusinessVault home"
      >
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt=""
          aria-hidden="true"
          className="h-9 w-9 object-contain"
        />
        <span>BusinessVault</span>
      </Link>
      <div className="flex items-center gap-2">
        <CloudIndicator />
        <ThemeToggle />
      </div>
    </header>
  );
}
