import express from "express";
import cors from "cors";
import db from "./src/initializeDatabase";
import SendError from "./src/error";
import {
  TAttemptLoginRes,
  TGetEventSummariesRes,
  TGetScansRes,
  TGetUpcomingEventsRes,
  TGetUserAttendanceRes,
  TEventSummaries,
  TScansPerEvent,
  TCreateEvent,
} from "./BackendTypes/res";
import { eventTypeThresholds } from "./BackendTypes/db";
const converter = require("json-2-csv");
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// ############################## Test Endpoints ##############################
app.get("/", (req, res) => {
  res.send({ message: "Hello World" });
});

// ############################## Scan Endpoints ##############################

app.get("/GetScans", (req, res) => {
  console.log("Get Scans");
  db("Scan")
    .select()
    .then((scans) => {
      res.send({ status: "success", scans: scans } satisfies TGetScansRes);
    });
});

app.post("/InsertScan", (req, res) => {
  const { netId, plusOne, scannerId, eventId } = req.body;
  if (!netId || !scannerId || !eventId) {
    SendError(res, "insufficientData");
    return;
  }
  console.log("Insert scan");
  db("Scan")
    .insert({
      netId: netId,
      eventId: eventId,
      scannerId: scannerId,
      timestamp: new Date(),
      plusOne: plusOne,
    })
    .then(() => {
      res.send({ status: "success" });
    })
    .catch((err) => {
      if (err.code === "SQLITE_CONSTRAINT") {
        SendError(res, "duplicateScan");
        return;
      }
      SendError(res, "unknownError");
    });
});

// ############################## Event Info Endpoints ##############################

app.get("/GetUserAttendance/:netId", (req, res) => {
  console.log("User Attendance");
  const netId = req.params.netId;
  if (!netId) {
    SendError(res, "insufficientData");
    return;
  }
  db("Scan")
    .where("netId", netId)
    .select()
    .then((scans) => {
      db("Event")
        .whereIn(
          "eventId",
          scans.map((scan) => scan.eventId)
        )
        .select()
        .orderBy("startTime", "desc")
        .then((events) => {
          res.send({
            status: "success",
            scans: scans,
            events: events,
          } satisfies TGetUserAttendanceRes);
        });
    });
});

app.get("/GetUpcomingEvents", (req, res) => {
  console.log("Upcoming Events");
  const fourHoursAgo = new Date();
  fourHoursAgo.setHours(fourHoursAgo.getHours() - 4);

  db("Event")
    .where("startTime", ">", fourHoursAgo)
    .select()
    .orderBy("startTime", "asc")
    .then((events) => {
      res.send({ status: "success", events: events } satisfies TGetUpcomingEventsRes);
    });
});

const raffleEligibleHavingClause =
  Object.keys(eventTypeThresholds)
    .map((eventType) => {
      return `sum(case when type = '${eventType}' then 1 else 0 end) >= 1`;
    })
    .join(" AND ") + " AND count(Event.eventId) >= 10";

app.get("/GetEventSummaries", async (req, res) => {
  console.log("Event Summaries");
  const lastFiveEvents = await db("Event")
    .select()
    .orderBy("startTime", "desc")
    .limit(5)
    .then((events) => {
      return events;
    });

  const last5EventScans = await db("Scan")
    .whereIn(
      "eventId",
      lastFiveEvents.map((event) => event.eventId)
    )
    .select()
    .then((scans) => {
      return scans;
    });

  const scansPerEvent = last5EventScans.reduce((acc, scan) => {
    acc[scan.eventId] = {
      numScans: (acc[scan.eventId]?.numScans || 0) + 1,
      name: lastFiveEvents.find((event) => event.eventId === scan.eventId)?.title,
      date: lastFiveEvents.find((event) => event.eventId === scan.eventId)?.startTime,
    } satisfies TScansPerEvent;
    return acc;
  }, {});

  const totalAttendance = await db("Scan")
    .select()
    .then((scans) =>
      scans.reduce((acc, scan) => {
        return acc + 1 + scan.plusOne;
      }, 0)
    );

  const raffleEligibleStudents = await db("Scan")
    .join("Event", "Scan.eventId", "Event.eventId")
    .groupBy("netId")
    .having(db.raw(raffleEligibleHavingClause))
    .select()
    .then((students) => students.map((student) => student.netId));

  const eventSummaries: TEventSummaries = {
    scansPerEvent,
    totalAttendance,
    raffleEligibleStudents,
  };

  res.send({ status: "success", eventSummaries: eventSummaries } satisfies TGetEventSummariesRes);
});

app.get("/StudentRaffle", (req, res) => {
  console.log("Student Raffle");
  db("Scan")
    .join("Event", "Scan.eventId", "Event.eventId")
    .groupBy("netId")
    .having(db.raw(raffleEligibleHavingClause))
    .select("netId")
    .then(async (students) => {
      const raffleUsers = await db("User")
        .select()
        .whereIn(
          "netId",
          students.map((student) => student.netId)
        )
        .then((users) => users);
      const csv = converter.json2csv(raffleUsers);
      fs.writeFileSync("raffleEligibleStudents.csv", csv);
      res.download("raffleEligibleStudents.csv");
    });
});

// ############################## Event CRUD Endpoints ##############################

app.post("/CreateEvent", (req, res) => {
  const { title, type, notes, startTime, endTime, location, createdBy, waiverUrl } = req.body;
  if (!title || !type || !startTime || !endTime || !location || !createdBy) {
    SendError(res, "insufficientData");
    return;
  }
  console.log("Create event");
  db("Event")
    .insert({
      title: title,
      type: type,
      notes: notes,
      startTime: startTime,
      endTime: endTime,
      location: location,
      createdBy: createdBy,
      createdDate: new Date(),
      editedBy: createdBy,
      editDate: new Date(),
      waiverUrl: waiverUrl,
    })
    .then(() => {
      res.send({ status: "success" } satisfies TCreateEvent);
    });
});

// ############################## Auth Endpoints ##############################

app.post("/AttemptLogin", (req, res) => {
  const { netId } = req.body;
  if (!netId) {
    SendError(res, "insufficientData");
    return;
  }
  console.log("Attempt login");
  db("User")
    .where({ netId: netId })
    .select()
    .then((user) => {
      if (user.length === 0) {
        SendError(res, "noUser");
        return;
      }
      res.send({ status: "success", user: user[0] } satisfies TAttemptLoginRes);
    });
});

app.listen(8080, () => {
  console.log("Server is running on port 8080");
});
