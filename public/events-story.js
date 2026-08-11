(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const transition = document.querySelector('.events-transition');
  if (!transition || reducedMotion.matches) return;

  let queued = false;
  const updateTransition = () => {
    queued = false;
    const rect = transition.getBoundingClientRect();
    const viewport = window.innerHeight || 1;
    const progress = Math.min(1, Math.max(0, (viewport - rect.top) / (viewport + rect.height)));
    transition.style.setProperty('--transition-progress', progress.toFixed(3));
  };
  const onScroll = () => {
    if (!queued) {
      queued = true;
      window.requestAnimationFrame(updateTransition);
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  updateTransition();
})();
