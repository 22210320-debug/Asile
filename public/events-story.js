(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const transition = document.querySelector('.events-transition');
  const sunset = document.querySelector('.sunset-event-section');
  if ((!transition && !sunset) || reducedMotion.matches) return;

  const visibleSections = new Set();
  let frameId = 0;

  function scrollProgress(section) {
    const rect = section.getBoundingClientRect();
    const viewport = window.innerHeight || 1;
    const scrollDistance = Math.max(rect.height - viewport, 1);
    return Math.min(1, Math.max(0, -rect.top / scrollDistance));
  }

  const updateTransition = () => {
    frameId = 0;
    if (!visibleSections.size) return;

    if (sunset) {
      const progress = scrollProgress(sunset);
      sunset.style.setProperty('--sunset-progress', progress.toFixed(3));
      sunset.style.setProperty('--sunset-content-offset', `${(-32 * progress).toFixed(1)}px`);
      sunset.style.setProperty('--sunset-background-opacity', (0.72 - progress * 0.28).toFixed(3));
      sunset.style.setProperty('--sunset-content-opacity', (1 - progress * 0.42).toFixed(3));
    }

    if (transition)
      transition.style.setProperty('--transition-progress', scrollProgress(transition).toFixed(3));
  };

  const onScroll = () => {
    if (visibleSections.size && !frameId) frameId = window.requestAnimationFrame(updateTransition);
  };

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) visibleSections.add(entry.target);
      else visibleSections.delete(entry.target);
      if (visibleSections.size) onScroll();
    },
    { rootMargin: '20% 0px' }
  );

  if (sunset) observer.observe(sunset);
  if (transition) observer.observe(transition);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
})();
