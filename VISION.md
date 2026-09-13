# Vision

`Gonna Rain?` exists to answer one question - is rain about to interrupt you, here, soon - and to interrupt you only when the answer is yes.
It serves an iPhone user who wants to be warned before the rain, not educated about the weather.
It owns exactly one thing: the next hour of rain at your location, on your lock screen before it matters.

## One question

The app answers "gonna rain?"; it does not become a weather app - the native iOS Weather app already exists for everything beyond the hour.
The weekly view exists to frame the hour; the hour is the product.
A feature that answers a different question - climate, radar browsing, severe-weather safety - is resisted, however adjacent it feels.

## An interruption must earn itself

A notification exists only because the user asked for a lead time; it arrives no later than that lead time - up to one server check period (currently 10 minutes) early is the safe direction and is accepted, as is a rain-start alert up to five minutes past the forecast onset, since the forecast series is stamped a few minutes behind the check that reads it - and past that slack, a late alert is a bug of the highest class.
A wrong alert, a duplicate alert, or an alert that silently stops coming ranks above any feature work.
Copy states what the rain does - starts, stops - in plain, friendly words, and never gives advice.
Quiet hours are honoured, no badge is requested, and nothing nags.

## Platform citizenship

App Store guidelines are followed to the letter, down to the attribution glyph and the encryption declaration.
Apple's WeatherKit is the default data truth; a supplemental provider is welcome only where Apple has no minute data, and Apple wins wherever both exist.
It does not run its own forecast model.
Apple's operational budgets - APNs token reuse, push rates - are respected by design, not by luck.

## The free tier is a design constraint

The backend fits Cloudflare's free plan deliberately: caps, budgets, and TTLs are sized to the platform's published limits with arithmetic shown.
Scaling questions are answered by re-deriving the budget, not by reaching for a bigger bill, and scaling spends money only after usage data shows real users.

## A public API assumes a hostile internet

Every public endpoint validates its input, rate-limits its callers, and expires stale state.
Test and debug surfaces are auth-gated or absent in production.
Registrations are anonymous device tokens; the service knows where it rains, not who you are.

## Claims are verified

Every PR builds and runs headless tests in CI; user-visible behaviour changes carry a test or a reproduction.
A safety claim written in a comment must be true of the code, and when it is found false, fixing the claim is not optional.

## Scope

It is not a general weather app, a radar browser, or a forecast encyclopedia.
It is not a severe-weather safety service: it warns about rain on your walk, not tornadoes, and it never implies life-safety coverage.
It is not cross-platform: it is an iOS app by identity, not by backlog.
It has no accounts, no profiles, and no social surface.
A watchOS surface for the same question is in vision, sequenced after the next App Store release.

A change aligns when it makes the next hour of rain more accurate, more timely, or more trustworthy at the moment it interrupts.
A change should be resisted when it answers a question other than "gonna rain?", interrupts without being asked, adds identity or a paid dependency the arithmetic does not force, or weakens the honesty of an alert.
