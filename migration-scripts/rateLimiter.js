const rateLimiter = (limitDuration, maxRequests) =>
  async (req, res, next) => {
    const ipAddress = req.connection.remoteAddress;
    cache.increment(ipAddress, 1, (err, requestCount) => {
      if (err) {
        return res.status(500).json({ error: "Internal server error" });
      }
      requestCount = requestCount || 1;
      if (requestCount > maxRequests) {
        return res.json({
          loggedIn: false,
          status: "Slow down!! Try again in a minute.",
        });
      }
      cache.ttl(ipAddress, limitDuration, (err, success) => {
        if (err) {
          return res.status(500).json({ error: "Internal server error" });
        }
        next();
      });
    });
  };

