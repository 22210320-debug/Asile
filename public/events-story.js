(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const transition = document.querySelector('.events-transition');
  const undergroundEvent = document.querySelector('[data-scroll-reveal]');
  if (!transition || !undergroundEvent || reducedMotion.matches) return;

  document.documentElement.classList.add('events-motion-enabled');

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

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.16 }
  );
  observer.observe(undergroundEvent);
})();
