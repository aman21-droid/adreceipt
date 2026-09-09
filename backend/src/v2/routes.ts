import { Router } from "express";
import { isAddress } from "ethers";
import { asyncRoute, badRequest, HttpError, notFound } from "../server/errors";
import type { CampaignService } from "./service";
import { decideContext } from "./context/policy";
import { ManifestError } from "./campaigns/manifest";
import { EnvelopeError } from "./context/envelope";
import { NotFoundError, type EventKind, type Store } from "./store/store";
import { REASON_TEXT } from "./reasons";

/**
 * V2 API surface.
 *
 * Mounted under /v2 so the receipt and onboarding routes stay exactly as they
 * were and can be reviewed independently of this work.
 *
 * Two response shapes matter here. A refusal to serve an ad is a successful
 * request with `adServed: false` and a stable reason code - it is an answer, not
 * an error, and turning it into a 4xx would push callers towards treating a
 * policy decision as a bug to retry around. A missing database, by contrast, is
 * a 503: nothing about the request was wrong, and the caller should back off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const UINT = /^(0|[1-9][0-9]{0,29})$/;

function body(req: { body?: unknown }): Record<string, unknown> {
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    throw badRequest("invalid-body", "Request body must be a JSON object");
  }
  return req.body as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw badRequest("invalid-id", `${field} must be a UUID`);
  }
  return value;
}

function key(value: unknown, field: string): string {
  if (typeof value !== "string" || !KEY.test(value)) {
    throw badRequest("invalid-key", `${field} must be 8-128 characters of [A-Za-z0-9._:-]`);
  }
  return value;
}

/** Validation errors from the domain modules carry no user data, so they are safe to echo. */
function domainError(cause: unknown): never {
  if (cause instanceof ManifestError) throw badRequest("invalid-manifest", cause.message);
  if (cause instanceof EnvelopeError) throw badRequest("invalid-envelope", cause.message);
  if (cause instanceof NotFoundError) throw notFound("not-found", cause.message);
  throw cause;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    return domainError(cause);
  }
}

export function createV2Router(deps: { service: CampaignService; store: Store }): Router {
  const routes = Router();
  const { service, store } = deps;

  // -- advertisers --------------------------------------------------------

  routes.post(
    "/advertisers",
    asyncRoute(async (req, res) => {
      const input = body(req);
      const name = input.name;
      const payer = input.payer;
      if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 120) {
        throw badRequest("invalid-name", "name must be 1-120 characters");
      }
      if (typeof payer !== "string" || !isAddress(payer)) {
        throw badRequest("invalid-payer", "payer must be an Ethereum address");
      }
      return res.status(201).json(await store.createAdvertiser({ name: name.trim(), payer }));
    }),
  );

  // -- campaigns ----------------------------------------------------------

  routes.post(
    "/campaigns",
    asyncRoute(async (req, res) => {
      const input = body(req);
      const advertiserId = uuid(input.advertiserId, "advertiserId");
      const campaign = await guard(() => service.createDraft(advertiserId, input.manifest));
      return res.status(201).json(campaign);
    }),
  );

  routes.post(
    "/campaigns/:id/revisions",
    asyncRoute(async (req, res) => {
      const id = uuid(req.params.id, "id");
      const campaign = await guard(() => service.revise(id, body(req).manifest));
      return res.status(201).json(campaign);
    }),
  );

  routes.post(
    "/campaigns/:id/approve",
    asyncRoute(async (req, res) =>
      res.json(await guard(() => service.approve(uuid(req.params.id, "id")))),
    ),
  );

  routes.post(
    "/campaigns/:id/pause",
    asyncRoute(async (req, res) =>
      res.json(await guard(() => service.pause(uuid(req.params.id, "id")))),
    ),
  );

  routes.get(
    "/campaigns/:id",
    asyncRoute(async (req, res) => {
      const campaign = await service.get(uuid(req.params.id, "id"));
      if (!campaign) throw notFound("not-found", "campaign does not exist");
      return res.json(campaign);
    }),
  );

  routes.get(
    "/campaigns/:id/revisions",
    asyncRoute(async (req, res) =>
      res.json({ revisions: await guard(() => service.revisions(uuid(req.params.id, "id"))) }),
    ),
  );

  // -- context and eligibility -------------------------------------------

  /**
   * Classify only. Returns the sanitised envelope so a caller can see exactly
   * what the rest of the system will act on - which is the point: whatever the
   * classifier said about the query, only this survives.
   */
  routes.post(
    "/context/classify",
    asyncRoute(async (req, res) => {
      const input = body(req);
      const decision = decideContext(input.envelope, {
        available: input.classificationAvailable !== false,
      });
      return decision.allowed
        ? res.json({ adEligible: true, envelope: decision.envelope })
        : res.json({
            adEligible: false,
            reason: decision.reason,
            message: REASON_TEXT[decision.reason],
          });
    }),
  );

  routes.post(
    "/placements/find",
    asyncRoute(async (req, res) => {
      const input = body(req);
      const decision = await service.findPlacement({
        proposedEnvelope: input.envelope,
        classificationAvailable: input.classificationAvailable !== false,
      });
      return res.json(
        decision.adServed ? decision : { ...decision, message: REASON_TEXT[decision.reason] },
      );
    }),
  );

  // -- reservations -------------------------------------------------------

  routes.post(
    "/reservations",
    asyncRoute(async (req, res) => {
      const input = body(req);
      const amount = input.amount;
      if (typeof amount !== "string" || !UINT.test(amount) || BigInt(amount) <= 0n) {
        throw badRequest("invalid-amount", "amount must be a positive integer string");
      }
      const outcome = await guard(() =>
        service.reserve({
          reservationKey: key(input.reservationKey, "reservationKey"),
          campaignId: uuid(input.campaignId, "campaignId"),
          amount,
        }),
      );
      return outcome.ok
        ? res.status(201).json(outcome)
        : res.status(409).json({ ...outcome, message: REASON_TEXT[outcome.reason] });
    }),
  );

  routes.delete(
    "/reservations/:reservationKey",
    asyncRoute(async (req, res) => {
      const released = await service.release(key(req.params.reservationKey, "reservationKey"));
      return res.json({ released });
    }),
  );

  // -- measurement --------------------------------------------------------

  routes.post(
    "/measurement/events",
    asyncRoute(async (req, res) => {
      const input = body(req);
      const kind = input.kind;
      if (kind !== "IMPRESSION" && kind !== "CLICK") {
        throw badRequest("invalid-kind", "kind must be IMPRESSION or CLICK");
      }
      const result = await guard(() =>
        service.recordEvent({
          eventKey: key(input.eventKey, "eventKey"),
          campaignId: uuid(input.campaignId, "campaignId"),
          kind: kind as EventKind,
        }),
      );
      // 200 rather than 201 on a duplicate: nothing was created the second time.
      return res.status(result.recorded ? 201 : 200).json(result);
    }),
  );

  routes.get(
    "/campaigns/:id/delivery",
    asyncRoute(async (req, res) => {
      const id = uuid(req.params.id, "id");
      try {
        return res.json(await service.report(id));
      } catch (cause) {
        if (cause instanceof NotFoundError) throw notFound("not-found", cause.message);
        // Spend is unreadable, so no honest report exists. Say so.
        throw new HttpError(
          503,
          "spend-unavailable",
          "Settled spend could not be read, so no delivery report can be produced.",
        );
      }
    }),
  );

  return routes;
}

/**
 * Stand-in mounted when PostgreSQL is not configured.
 *
 * Every V2 route answers 503 with the same code. The alternative - starting with
 * an in-memory store - would look healthy in development and lose every
 * reservation on restart in production, over-delivering campaigns precisely
 * because nothing appeared to be wrong.
 */
export function createUnavailableV2Router(reason: string): Router {
  const routes = Router();
  routes.use((_req, res) =>
    res.status(503).json({
      error: "storage-unavailable",
      message: reason,
    }),
  );
  return routes;
}
