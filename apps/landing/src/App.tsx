import React from 'react';
import { useTranslation } from 'react-i18next';

function App() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-dark-950 text-white flex flex-col items-center justify-center">
      <h1 className="text-4xl font-bold mb-4">{t('welcome', 'Welcome to GitOrch')}</h1>
      <p className="text-lg text-dark-300">
        Multi-agent orchestration control plane.
      </p>
    </div>
  );
}

export default App;
