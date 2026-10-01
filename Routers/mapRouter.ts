import express from "express";
import * as mapController from "../Controllers/mapController";

// /api/v1/map - the site's NexaMap gateway (Controllers/mapController.ts).
// Public: maps show on public pages. Each IP gets a per-minute budget;
// tiles get a larger one (a map view loads dozens).
const router = express.Router();
const lookups = mapController.mapRateLimit(120);
const heavy = mapController.mapRateLimit(30);

router.get("/config", mapController.getMapConfig);
router.get("/style.json", mapController.getStyle);
router.get(/^\/raw\/(.*)$/, mapController.mapRateLimit(1500), mapController.getRaw);
router.get("/staticmap", lookups, mapController.getStaticMap);

router.get("/geocode", lookups, mapController.geocode);
router.get("/reverse", lookups, mapController.reverse);
router.get("/autocomplete", mapController.mapRateLimit(300), mapController.autocomplete);
router.get("/search", lookups, mapController.search);
router.get("/places/details", lookups, mapController.placeDetails);
router.get("/place-info", lookups, mapController.placeInfo);
router.get("/divisions/:kind", lookups, mapController.divisions);

router.post("/route", heavy, mapController.route);
router.post("/route/export", heavy, mapController.routeExport);
router.post("/matrix", heavy, mapController.matrix);
router.post("/isochrone", heavy, mapController.isochrone);
router.post("/trip-cost", heavy, mapController.tripCost);

router.get("/traffic/flow", lookups, mapController.trafficFlow);
router.get("/traffic-zones", lookups, mapController.trafficZones);
router.get("/incidents", lookups, mapController.incidents);
router.get("/parking", lookups, mapController.parking);
router.get("/air-quality", lookups, mapController.airQuality);

export default router;
