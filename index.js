const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const fastCsv = require("fast-csv");
const axios = require("axios");
const { default: cluster } = require("cluster");

const app = express();
const port = 5001;

// OSRM base URL
const OSRM_BASE_URL = "http://router.project-osrm.org/route/v1/driving";
// Nominatim base URL
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";

const originCoordinatesMap = new Map();

app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ dest: "uploads/" });

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headersTrimmed = false; // Flag to ensure headers are trimmed only once

    fs.createReadStream(filePath)
      .pipe(
        csv({
          mapHeaders: ({ header }) => {
            // Trim spaces from column headers
            if (header) {
              return header.trim();
            }
            return header;
          },
        })
      )
      .on("data", (row) => {
        return rows.push(row)
      })
      .on("end", () => resolve(rows))
      .on("error", (error) => reject(error));
  });
}

function writeCsv(filePath, data) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    fastCsv
      .write(data, { headers: true })
      .pipe(ws)
      .on("finish", resolve)
      .on("error", reject);
  });
}

function calculateDistance(coord1, coord2) {
  try {
    // console.log("Entered calculateDistance");
    // console.log("Coordinate 1:", JSON.stringify(coord1));
    // console.log("Coordinate 2:", JSON.stringify(coord2));

    // Validate input coordinates
    if (!coord1 || !coord2) {
      throw new Error("Invalid coordinates: Both coord1 and coord2 must be provided");
    }

    const { lat: lat1, lng: lng1 } = coord1;
    const { lat: lat2, lng: lng2 } = coord2;

    // Validate latitude and longitude values
    if (typeof lat1 !== 'number' || typeof lng1 !== 'number' || 
        typeof lat2 !== 'number' || typeof lng2 !== 'number') {
      throw new Error("Coordinates must be numeric values");
    }

    if (lat1 < -90 || lat1 > 90 || lat2 < -90 || lat2 > 90 ||
        lng1 < -180 || lng1 > 180 || lng2 < -180 || lng2 > 180) {
      throw new Error("Coordinates are out of valid range");
    }

    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) *
        Math.cos(lat2 * rad) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const radius = 6371; // Earth's radius in kilometers
    const distance = radius * c;

    // console.log(`Calculated great-circle distance: ${distance.toFixed(2)} kilometers`);
    return distance;
  } catch (error) {
    console.error("Error in calculateDistance:", error.message);
    console.error("Input coordinates:", JSON.stringify({ coord1, coord2 }));
    throw error; // Re-throw to allow caller to handle the error
  }
}


async function getRoadRouteDistance(origin, destination, originPincode) {
  try {
    // console.log("Entered getRoadRouteDistance");
    // console.log("Origin:", JSON.stringify(origin));
    // console.log("Destination:", JSON.stringify(destination));

    if (!origin || !destination) {
      throw new Error("Invalid coordinates: Both origin and destination must be provided");
    }

    const { lat: originLat, lng: originLng } = origin;
    const { lat: destLat, lng: destLng } = destination;

    if (typeof originLat === 'number' && typeof originLng === 'number') {
      // Store the origin coordinate in the map if it doesn't already exist
      if (!originCoordinatesMap.has(originPincode)) {
        originCoordinatesMap.set(originPincode, { lat: originLat, lng: originLng });
      }
    }

    const response = await axios.get(
      `${OSRM_BASE_URL}/${originLng},${originLat};${destLng},${destLat}`,
      {
        params: {
          overview: "false",
          annotations: "distance",
        },
        timeout: 10000,
      }
    );

    const routes = response.data.routes;
    if (routes && routes.length > 0) {
      const roadDistance = routes[0].distance / 1000; // Convert meters to kilometers
      // console.log(`Road route distance: ${roadDistance.toFixed(2)} kilometers`);
      return roadDistance;
    }

    console.warn("No routes found in OSRM API response");
    return null;
  } catch (error) {
    console.error("Error in getRoadRouteDistance:", error.message);
    throw error;
  }
}


async function getCoordinates(pincode) {
  try {
    // console.log("Entered getCoordinates");
    const response = await axios.get(NOMINATIM_BASE_URL, {
      params: {
        q: pincode,
        format: 'json',
        limit: 1
      },
      headers: {
        'User-Agent': 'DeliveryOptimizationApp/1.0'
      }
    });

    if (response.data && response.data.length > 0) {
      return {
        lat: parseFloat(response.data[0].lat),
        lng: parseFloat(response.data[0].lon)
      };
    }
    return null;
  } catch (error) {
    console.error("Error fetching coordinates:", error.message);
    return null;
  }
}

async function getDirectionsRoute(origin, destinations, originCoordinatesList) {
  // console.log("Entered getDirectionsRoute");
  try {
    // Sort destinations by stop order
    const sortedDestinations = destinations.sort((a, b) => a.Stop_Order - b.Stop_Order);
    // Construct coordinates string for OSRM, including origin as the starting point
    const coordinates = [
      `${origin.lng},${origin.lat}`,
      ...originCoordinatesList.map(dest => `${dest.lng},${dest.lat}`)
    ];

    const response = await axios.get(
      `${OSRM_BASE_URL}/${coordinates.join(';')}`,
      {
        params: {
          overview: 'full',
          geometries: 'polyline',
          steps: 'true',
          annotations: 'true'
        }
      }
    );

    // Extract route data with detailed information
    const route = response.data.routes[0];

    if (route) {
      const totalDistance = route.distance / 1000; // Total route distance in kilometers
      return {
        geometry: route.geometry,
        distance: totalDistance,
        duration: route.duration / 60, // Total route duration in minutes
        steps: route.legs.flatMap(leg => leg.steps),
        waypoints: coordinates.map((coord, index) => ({
          location: coord.split(',').map(parseFloat),
          type: index === 0 ? 'origin' : 'destination',
          order: index === 0 ? 0 : sortedDestinations[index - 1].Stop_Order
        }))
      };
    }

    return null;
  } catch (error) {
    console.error("Error fetching route directions:", error.message);
    return null;
  }
}

function normalizeClusterIds(clusters) {
  // console.log("Entered normalizeClusterIds");
  // Find unique cluster IDs and sort them
  const uniqueClusterIds = [...new Set(clusters.map(cluster => cluster.id))].sort((a, b) => a - b);

  // Create a mapping of old cluster IDs to new cluster IDs
  const clusterIdMap = new Map();
  uniqueClusterIds.forEach((oldId, index) => {
    clusterIdMap.set(oldId, index + 1);
  });

  // Update cluster IDs
  clusters.forEach(cluster => {
    const newId = clusterIdMap.get(cluster.id);
    cluster.id = newId;

    // Update cluster_id for each delivery in the cluster
    cluster.deliveries.forEach(delivery => {
      delivery.cluster_id = newId;
    });
  });

  return clusters;
}

function calculateSpread(cluster) {
  // console.log("Entered calculateSpread");
  const coordinates = cluster.deliveries.map((delivery) => delivery.coordinates);
  let maxDistance = 0;

  for (let i = 0; i < coordinates.length; i++) {
    for (let j = i + 1; j < coordinates.length; j++) {
      const distance = calculateDistance(coordinates[i], coordinates[j]);
      maxDistance = Math.max(maxDistance, distance);
    }
  }
  return maxDistance;
}

function determineTruckModel(clusterVolume, clusterWeight, truckModels) {
  // console.log("Entered determineTruckModel");
  // console.log("Cluster Volume:", clusterVolume);
  // console.log("Cluster Weight:", clusterWeight);
  // console.log("Truck Models:", truckModels);

  let selectedTruck = null;

  // Sort truck models by volume capacity in ascending order
  const sortedTrucks = truckModels.sort((a, b) => 
    parseFloat(a["usable_volume_cft"]) - parseFloat(b["usable_volume_cft"])
  );

  for (const truck of sortedTrucks) {
    const volumeCapacity = parseFloat(truck["usable_volume_cft"]);
    const weightCapacity = parseFloat(truck["payload_kgs"]);

    // console.log(`Checking truck: ${truck["truck_name"]}, Volume Capacity: ${volumeCapacity}, Weight Capacity: ${weightCapacity}`);

    if (clusterVolume <= volumeCapacity && clusterWeight <= weightCapacity) {
      selectedTruck = truck["truck_name"];
      // console.log(`Selected Truck: ${selectedTruck}`);
      break;
    }
  }

  if (!selectedTruck) {
    // console.log("No suitable truck found for volume:", clusterVolume, "and weight:", clusterWeight);
  }

  return selectedTruck;
}

async function createGeographicalClusters(deliveries) {
  const clusters = [];
  let clusterIdCounter = 1;

  for (const delivery of deliveries) {
    const originCoords = await getCoordinates(delivery["Origin Pincode"]);
    const destinationCoords = await getCoordinates(delivery["Destination Pincode"]);

    if (!originCoords || !destinationCoords) {
      console.error(`Could not fetch coordinates for pincode: ${delivery["Origin Pincode"]} or ${delivery["Destination Pincode"]}`);
      continue;
    }

    delivery.coordinates = destinationCoords;

    let addedToExistingCluster = false;

    for (const cluster of clusters) {
      // Get road route distances
      const originRouteDistance = await getRoadRouteDistance(cluster.originCoordinates, originCoords);
      const destinationRouteDistance = await getRoadRouteDistance(cluster.destinationCoordinates, destinationCoords);

      const spread = calculateSpread(cluster);
      const spreadFactor = spread > 20 ? 2 : 1;
      const dynamicRadius = Math.sqrt(cluster.totalVolume) * 1.5 + cluster.deliveries.length * 3 * spreadFactor;

      if (originRouteDistance !== null && destinationRouteDistance !== null &&
        originRouteDistance <= dynamicRadius && destinationRouteDistance <= dynamicRadius) {
        cluster.deliveries.push(delivery);
        cluster.originCoordinatesList.push(originCoords); // Add origin coordinates to the cluster

        // Calculate total volume and total weight for the cluster
        cluster.totalVolume += delivery.Volume;
        cluster.totalWeight += delivery.Weight;

        delivery.cluster_id = cluster.id;
        addedToExistingCluster = true;
        break;
      }
    }

    if (!addedToExistingCluster) {
      const newCluster = {
        id: clusterIdCounter++,
        originCoordinates: originCoords,
        originCoordinatesList: [originCoords], // Initialize list with first origin coordinate
        destinationCoordinates: destinationCoords,
        deliveries: [delivery],
        totalVolume: delivery.Volume,
        totalWeight: delivery.Weight,
      };
      clusters.push(newCluster);
      delivery.cluster_id = newCluster.id;
    }
  }

  return {
    clusters: clusters,
    lastClusterId: clusterIdCounter - 1,
  };
}



function splitCluster(cluster, startingClusterId) {
  // console.log("Entered splitCluster");
  const finalClusters = [];
  let currentClusterId = startingClusterId;

  // Sort deliveries by a combination of volume and weight in descending order
  const sortedDeliveries = [...cluster.deliveries].sort((a, b) => {
    // Combine volume and weight for sorting
    const scoreA = a.Volume + a.Weight;
    const scoreB = b.Volume + b.Weight;
    return scoreB - scoreA;
  });

  // Initialize the first sub-cluster
  let currentCluster = {
    id: currentClusterId++,
    originCoordinates: cluster.originCoordinates,
    destinationCoordinates: cluster.destinationCoordinates,
    deliveries: [],
    totalVolume: 0,
    totalWeight: 0
  };

  // Distribute deliveries across sub-clusters
  sortedDeliveries.forEach((delivery) => {
    // If current cluster exceeds either volume or weight limit, create a new cluster
    if (currentCluster.totalVolume + delivery.Volume > 1500 ||
        currentCluster.totalWeight + delivery.Weight > 14000) {
      // Add current cluster to final clusters if it has deliveries
      if (currentCluster.deliveries.length > 0) {
        finalClusters.push(currentCluster);
      }

      // Start a new cluster
      currentCluster = {
        id: currentClusterId++,
        originCoordinates: cluster.originCoordinates,
        destinationCoordinates: cluster.destinationCoordinates,
        deliveries: [],
        totalVolume: 0,
        totalWeight: 0
      };
    }

    // Add delivery to current cluster
    currentCluster.deliveries.push(delivery);
    currentCluster.totalVolume += delivery.Volume;
    currentCluster.totalWeight += delivery.Weight;
    delivery.cluster_id = currentCluster.id;
  });

  // Add the last cluster if it has deliveries
  if (currentCluster.deliveries.length > 0) {
    finalClusters.push(currentCluster);
  }

  return finalClusters;
}


function calculateDeliveryDays(totalDistance, dailyTravelDistance) {
  //  console.log("Entered calculateDeliveryDays");
  // Ensure the inputs are valid numbers and not zero
  totalDistance = parseFloat(totalDistance) || 0;
  dailyTravelDistance = parseFloat(dailyTravelDistance) || 100; // Default to max trip distance for TATA ACE

  if (dailyTravelDistance <= 0) {
    return null; // Return null if the truck cannot travel any distance
  }

  // For TATA ACE, if total distance exceeds 100 km, return null (cannot complete trip)
  if (dailyTravelDistance === 100 && totalDistance > 100) {
    return null;
  }

  // Calculate delivery days based on total route distance
  const daysRequired = Math.max(1, Math.ceil(totalDistance / dailyTravelDistance));
  return daysRequired;
}



async function assignTrucksToCluster(cluster, truckModels) {
  // console.log("Entered assignTrucksToCluster");

  // First, try to determine the initial truck based on volume and weight
  let truckModel = determineTruckModel(cluster.totalVolume, cluster.totalWeight, truckModels);

  // Estimate total route distance
  let totalRouteDistance = 0;
  for (let i = 1; i < cluster.deliveries.length; i++) {
    const prevDelivery = cluster.deliveries[i - 1];
    const currentDelivery = cluster.deliveries[i];
    const legDistance = await getRoadRouteDistance(
      prevDelivery.coordinates,
      currentDelivery.coordinates
    );
    totalRouteDistance += legDistance;
  }

  // Add distance from origin to first delivery and last delivery to destination
  const originDistance = await getRoadRouteDistance(
    cluster.originCoordinates,
    cluster.deliveries[0].coordinates
  );
  const destinationDistance = await getRoadRouteDistance(
    cluster.deliveries[cluster.deliveries.length - 1].coordinates,
    cluster.destinationCoordinates
  );
  totalRouteDistance += originDistance + destinationDistance;

  // Round to two decimal places
  totalRouteDistance = Math.round(totalRouteDistance * 100) / 100;

  // If TATA ACE is selected and route distance exceeds 100 km
  if (truckModel === "TATA ACE" && totalRouteDistance > 100) {
    // Sort truck models by volume capacity in ascending order, starting from the next truck after TATA ACE
    const sortedTrucks = truckModels
      .filter(truck => {
        // Only consider trucks with higher volume capacity than TATA ACE
        const currentVolumeCapacity = truckModels.find(t => t["truck_name"] === "TATA ACE")["usable_volume_cft"];
        return parseFloat(truck["usable_volume_cft"]) > parseFloat(currentVolumeCapacity);
      })
      .sort((a, b) => parseFloat(a["usable_volume_cft"]) - parseFloat(b["usable_volume_cft"]));

    // Try to find a suitable truck that can handle the volume, weight, and distance
    for (const truck of sortedTrucks) {
      const volumeCapacity = parseFloat(truck["usable_volume_cft"]);
      const weightCapacity = parseFloat(truck["payload_kgs"]);
      const maxTripDistance = getDailyTravelDistance(truck["truck_name"]);

      if (cluster.totalVolume <= volumeCapacity &&
          cluster.totalWeight <= weightCapacity &&
          totalRouteDistance <= maxTripDistance) {
        truckModel = truck["truck_name"];
        break;
      }
    }
  }

  // Verify the truck's payload capacity
  const selectedTruck = truckModels.find(truck => truck["truck_name"] === truckModel);

  if (selectedTruck) {
    const payloadCapacity = parseFloat(selectedTruck["payload_kgs"]);
    const maxTripDistance = getDailyTravelDistance(truckModel);

    // Check both volume and payload constraints, and calculate delivery days
    if (cluster.totalVolume <= parseFloat(selectedTruck["usable_volume_cft"]) &&
        cluster.totalWeight <= payloadCapacity) {

      // Calculate total delivery days for the entire cluster
      const totalDeliveryDays = calculateDeliveryDays(totalRouteDistance, maxTripDistance);

      cluster.deliveries.forEach((delivery) => {
        delivery.Assigned_Truck = truckModel;
        // Remove DeliveryDays property from output, but keep calculation for internal use
        delivery._calculatedDeliveryDays = totalDeliveryDays;
      });

      // Set cluster-level route distance for potential future use
      cluster.totalRouteDistance = totalRouteDistance;

      // Log cluster details
      // console.log(`Cluster ${cluster.id} Details:`);
      // console.log(`- Assigned Truck: ${truckModel}`);
      // console.log(`- Total Route Distance: ${totalRouteDistance.toFixed(2)} km`);
      // console.log(`- Max Trip Distance: ${maxTripDistance} km`);
      // console.log(`- Total Deliveries: ${cluster.deliveries.length}`);
      // console.log(`- Total Volume: ${cluster.totalVolume.toFixed(2)} CFT`);
      // console.log(`- Total Weight: ${cluster.totalWeight.toFixed(2)} kg`);
      // console.log(`- Total Delivery Days: ${totalDeliveryDays}`);
    } else {
      cluster.deliveries.forEach((delivery) => {
        delivery.Assigned_Truck = "Not Assigned";
        delivery._calculatedDeliveryDays = null;
      });
      // console.log(`Cluster exceeds truck capacity. Volume: ${cluster.totalVolume}, Weight: ${cluster.totalWeight}`);
    }
  } else {
    cluster.deliveries.forEach((delivery) => {
      delivery.Assigned_Truck = "Not Assigned";
      delivery._calculatedDeliveryDays = null;
    });
    // console.log(`No suitable truck found for cluster. Volume: ${cluster.totalVolume}, Weight: ${cluster.totalWeight}`);
  }
}



function getDailyTravelDistance(truckModel) {
  // console.log("Entered getDailyTravelDistance");
  switch (truckModel) {
    case "TATA ACE":
      return 100; // Total trip distance, not daily distance
    case "TATA 407":
      return 200;
    case "EICHER 17 FEET":
      return 250;
    case "CONTAINER 20 FT":
       return 450;
    case "CONTAINER 32 FT SXL":
       return 450;
    case "CONTAINER 32 FT MXL":
       return 450;
    default:
      return 450;
  }
}



async function optimizeStopOrder(cluster) {
  // console.log("Entered optimizeStopOrder");
  const destinationCoords = cluster.deliveries.map((delivery) => delivery.coordinates);

  let currentStopIndex = 0;
  const visited = new Set([currentStopIndex]);
  const stopOrder = [currentStopIndex];

  while (visited.size < destinationCoords.length) {
    let nearestStopIndex = -1;
    let minDistance = Infinity;

    for (let i = 0; i < destinationCoords.length; i++) {
      if (visited.has(i)) continue;
      const distance = calculateDistance(destinationCoords[currentStopIndex], destinationCoords[i]);
      if (distance < minDistance) {
        minDistance = distance;
        nearestStopIndex = i;
      }
    }

    visited.add(nearestStopIndex);
    stopOrder.push(nearestStopIndex);
    currentStopIndex = nearestStopIndex;
  }

  cluster.deliveries.forEach((delivery, index) => {
    delivery.Stop_Order = stopOrder.indexOf(index) + 1;
  });
}

let globalClusters = []; // Global variable to store clusters for map visualization


app.post(
  "/optimize",
  upload.fields([
    { name: "deliveries", maxCount: 1 },
    { name: "truckMaster", maxCount: 1 },
    { name: "goodsMaster", maxCount: 1 }, // Add goodsMaster as optional
  ]),
  async (req, res) => {
    try {
      // Extract uploaded file paths
      const deliveriesFilePath = req.files.deliveries[0].path;
      const truckMasterFilePath = req.files.truckMaster[0].path;
      const goodsMasterFilePath = req.files.goodsMaster?.[0]?.path; // Optional file

      // Read CSV files
      const deliveries = await readCsv(deliveriesFilePath);
      const truckModels = await readCsv(truckMasterFilePath);
      let goodsMaster = [];

      if (goodsMasterFilePath) {
        goodsMaster = await readCsv(goodsMasterFilePath);
      }

      // Process deliveries
      const processedDeliveries = deliveries.map((delivery) => {
        let volume = parseFloat(delivery["Volume"] || delivery["CFT"]) || 0;
        let weight = parseFloat(delivery["Weight"] || delivery["weight(kgs)"]) || 0;
        let quantity = parseFloat(delivery["Qty"] || delivery["Quantity"]) || 1;
      
        // If goods master is available, use its values for multiplication
        if (goodsMasterFilePath) {
          // Find the matching record in goodsMaster
          const matchingGoods = goodsMaster.find((goodsDetails) => goodsDetails["ID"] === delivery["ID"]);
      
          if (matchingGoods) {
            volume = parseFloat(matchingGoods["CFT"] || matchingGoods["Volume"]) || volume;
            weight = parseFloat(matchingGoods["Weight"] || matchingGoods["weight(kgs)"]) || weight;
          }
        }
                  
        // Calculate multiplication value
        const multiplicationValue = volume * weight * quantity;

        // Log the multiplication value
        console.log(`Delivery ${delivery["ID"]} -----> ${multiplicationValue}`);


        return {
          cluster_id: null,
          delivery_id: delivery["ID"],
          "Origin Pincode": delivery["Origin Pincode"],
          "Destination Pincode": delivery["Destination Pincode"],
          Volume: volume,
          Weight: weight,
          Assigned_Truck: "",
          Stop_Order: "",
          Quantity: quantity,
        };
      });

      // Create geographical clusters
      const { clusters, lastClusterId } = await createGeographicalClusters(processedDeliveries);

      // Split clusters exceeding limits
      const finalClusters = [];
      let nextClusterId = 1;

      for (const cluster of clusters) {
        if (cluster.totalVolume > 1500 || cluster.totalWeight > 14000) {
          const splitResults = splitCluster(cluster, nextClusterId);
          finalClusters.push(...splitResults);
          nextClusterId += splitResults.length;
        } else {
          cluster.id = nextClusterId++;
          finalClusters.push(cluster);
        }
      }

      // Normalize cluster IDs
      const normalizedClusters = normalizeClusterIds(finalClusters);

      // Assign trucks and optimize stop orders
      for (const cluster of normalizedClusters) {
        await assignTrucksToCluster(cluster, truckModels);
        await optimizeStopOrder(cluster);
      }

      // Prepare final deliveries for output
      const finalDeliveries = processedDeliveries
        .map((delivery) => {
          const { coordinates, ...rest } = delivery;
          return rest;
        })
        .sort((a, b) => a.cluster_id - b.cluster_id);

      // Write optimized deliveries to CSV
      const outputFilePath = path.join(__dirname, "uploads", "optimized_deliveries.csv");
      await writeCsv(outputFilePath, finalDeliveries);

      // Store clusters globally for map visualization
      globalClusters = normalizedClusters;

      // Log cluster details
      normalizedClusters.forEach((cluster) => {
        console.log(`Cluster ID: ${cluster.id}`);
        console.log(`Origin Coordinates: 
  - Latitude: ${cluster.originCoordinates.lat}
  - Longitude: ${cluster.originCoordinates.lng}`);
        console.log(`Destination Coordinates: 
  - Latitude: ${cluster.destinationCoordinates.lat}
  - Longitude: ${cluster.destinationCoordinates.lng}`);
      });

      // Redirect to map page
      res.redirect('/map.html');
    } catch (error) {
      console.error("Error processing request:", error.message);
      res.status(500).send("An error occurred during optimization.");
    }
  }
);




// Update the get-optimized-clusters route to use _calculatedDeliveryDays
app.get('/get-optimized-clusters', async (req, res) => {
  try {
    const clustersWithRoutes = await Promise.all(globalClusters.map(async (cluster) => {
      const routeDetails = await getDirectionsRoute(
        cluster.originCoordinates,
        cluster.deliveries,
        cluster.originCoordinatesList
      );

      const totalVolume = cluster.deliveries.reduce((sum, delivery) => sum + delivery.Volume, 0);
      const totalWeight = cluster.deliveries.reduce((sum, delivery) => sum + delivery.Weight, 0);
      const deliveryDays = cluster.deliveries.reduce((total, delivery) => total + (delivery._calculatedDeliveryDays || 0), 0);

      return {
        clusterId: cluster.id,
        originCoordinates: cluster.originCoordinates,
        allOriginCoordinates: cluster.originCoordinatesList, // Include all origin coordinates
        destinationCoordinates: cluster.destinationCoordinates,
        selectedTruck: cluster.deliveries[0]?.Assigned_Truck || "Not Assigned",
        totalDeliveryDays: deliveryDays,
        totalVolume: totalVolume,
        totalWeight: totalWeight,
        routePolyline: routeDetails?.geometry || null,
        routeDetails: {
          totalDistance: routeDetails?.distance || 0,
          totalDuration: routeDetails?.duration || 0,
          waypoints: routeDetails?.waypoints || [],
        },
        deliveries: cluster.deliveries.map(delivery => ({
          deliveryId: delivery.delivery_id,
          originPincode: delivery["Origin Pincode"],
          destinationPincode: delivery["Destination Pincode"],
          volume: delivery.Volume,
          weight: delivery.Weight,
          assignedTruck: delivery.Assigned_Truck,
          stopOrder: delivery.Stop_Order,
          deliveryDays: delivery._calculatedDeliveryDays,
          coordinates: delivery.coordinates
        })),
      };
    }));

    res.json({
      clusters: clustersWithRoutes,
      totalClusters: clustersWithRoutes.length,
      totalDeliveries: clustersWithRoutes.reduce((sum, cluster) => sum + cluster.deliveries.length, 0),
    });
  } catch (error) {
    console.error("Error fetching cluster routes:", error.message);
    res.status(500).json({
      error: "An error occurred while fetching cluster routes.",
      details: error.message,
    });
  }
});


// Add a new route to serve the optimized CSV file
app.get('/download-optimized-csv', async (req, res) => {
  try {
    // Read the original CSV file
    const filePath = path.join(__dirname, "uploads", "optimized_deliveries.csv");
    
    // Read the CSV file
    const originalDeliveries = await readCsv(filePath);
    
    // Remove _calculatedDeliveryDays property from each delivery object
    const filteredDeliveries = originalDeliveries.map(delivery => {
      const { _calculatedDeliveryDays, ...filteredDelivery } = delivery;
      return filteredDelivery;
    });
    
    // Create a new CSV file with filtered data
    const outputFilePath = path.join(__dirname, "uploads", "filtered_optimized_deliveries.csv");
    await writeCsv(outputFilePath, filteredDeliveries);
    
    // Download the filtered CSV file
    res.download(outputFilePath, "optimized_deliveries.csv", (err) => {
      if (err) {
        console.error("Download error:", err);
        res.status(500).send("Error downloading the file");
      }
      
      // Optional: Clean up the temporary file after download
      fs.unlink(outputFilePath, (unlinkErr) => {
        if (unlinkErr) console.error("Error deleting temporary file:", unlinkErr);
      });
    });
  } catch (error) {
    console.error("Error processing CSV download:", error.message);
    res.status(500).send("Error processing the CSV file");
  }
});


app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
