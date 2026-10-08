# Postgres LISTEN/NOTIFY as the run queue

New Runs are dispatched to workers via Postgres `NOTIFY` on a dedicated channel rather than a dedicated message queue (Redis/BullMQ) or polling. The worker maintains a persistent connection and wakes immediately on notification; a periodic safety-net poll catches any notifications missed during reconnection.

We already depend on Postgres for durable Run storage. Adding Redis as a mandatory second infrastructure dependency for the queue alone is a significant operational cost. `LISTEN/NOTIFY` gives sub-second dispatch latency with zero extra dependencies. The constraint is that the worker must keep a persistent Postgres connection alive; reconnection on network hiccup must be handled explicitly. `FOR UPDATE SKIP LOCKED` on the pickup query ensures multi-worker safety independently of the notification mechanism.
